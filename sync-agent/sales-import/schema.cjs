'use strict';
const crypto=require('node:crypto');
const TABLES=['TPSTSalHD','TPSTSalDT','TPSTSalRC','TPSTSalPD','TPSTSalPG','TPSTSalPH','TPSTSalInvCsm','TPSTVoidDT'];
const IGNORE=new Set(['FDDateIns','FTTimeIns','FTWhoIns','FDDateUpd','FTTimeUpd','FTWhoUpd','FTShdStaPrcDoc','FTShdStaPrcSpn','FTShdStaPrcCst','FTShdStaPrcGL','FTShdStaPrcStk','FTShdStaPrcLef','FTShdStaPrcCsm','FTSdtStaPrcStk','FTSdtStaPrcStkCrd','FTSrcStaPrc']);
const MARKER='b740db43-5811-44cb-b072-0480a0b26f19';
const SCOPE='SCCRM-HQ-SALES-IMPORT-V1';
const ACTIVE={TPSTSalHD:'TSHD',TPSTSalDT:'TSDT',TPSTSalRC:'TSRC',TPSTSalPD:'TSPD',TPSTSalPG:'TSPG',TPSTVoidDT:'TSVT'};
function sqlType(c){if(!['varchar','bigint','datetime','float','int'].includes(c.type_name))throw Error('SALES_SCHEMA_TYPE_REVIEW');return c.type_name==='varchar'?`varchar(${c.max_length})`:c.type_name==='float'?`float(${c.precision})`:c.type_name;}
function schema(probe){
 const cols=probe.columns;if(!Array.isArray(cols)||TABLES.some(t=>!cols.some(c=>c.table_name===t)))throw Error('SALES_SCHEMA_REQUIRED');
 if(cols.some(c=>!TABLES.includes(c.table_name)||!/^[A-Za-z0-9_]+$/.test(c.column_name)||/pin|password|secret|token/i.test(c.column_name)||c.is_computed||c.is_identity))throw Error('SALES_SCHEMA_COLUMN_REFUSED');cols.forEach(sqlType);
 const hash=crypto.createHash('sha256').update(JSON.stringify(cols)).digest('hex');return {columns:cols,hash,tables:TABLES};
}
function nativeTableDdl(s,t){return `CREATE TABLE dbo.[${t}](${s.columns.filter(c=>c.table_name===t).map(c=>`[${c.column_name}] ${sqlType(c)} ${c.is_nullable?'NULL':'NOT NULL'}`).join(',')});`;}
function sourceViews(s,branch){
 if(!['001','003','004','005'].includes(branch))throw Error('SALES_BRANCH_REFUSED');
 const names=s.columns.filter(c=>c.table_name==='TPSTSalHD').map(c=>`d.[${c.column_name}]`).join(',');
 const final=`d.FTBchCode='${branch}' AND d.FTPosCode IN('001','002') AND d.FTShdStaPaid='3' AND d.FTShdStaDoc='1' AND d.FTShdDocType IN('1','9') AND d.FDShdDocDate>='20261108'`;
 const header=`CREATE VIEW dbo.[SCCRM_SalesFinalHeaders] AS SELECT ${names},CONVERT(varchar(8),'archive') source_lane FROM dbo.TPSTSalHD d WHERE ${final}
 ${['001','002'].map(pos=>`UNION ALL SELECT ${names},CONVERT(varchar(8),'${pos}') source_lane FROM dbo.[TSHD${pos}] d WHERE ${final} AND d.FTPosCode='${pos}' AND NOT EXISTS(SELECT 1 FROM dbo.TPSTSalHD a WHERE a.FTShdDocNo=d.FTShdDocNo)`).join('\n')};`;
 return [header,...TABLES.map(t=>{
  const cols=s.columns.filter(c=>c.table_name===t).map(c=>`d.[${c.column_name}]`).join(',');
  if(t==='TPSTSalHD')return `CREATE VIEW dbo.[SCCRM_SalesExport_${t}] AS SELECT ${cols} FROM dbo.SCCRM_SalesFinalHeaders d;`;
  const archived=`SELECT ${cols} FROM dbo.[${t}] d JOIN dbo.SCCRM_SalesFinalHeaders h ON h.FTShdDocNo=d.FTShdDocNo`;
  if(!ACTIVE[t])return `CREATE VIEW dbo.[SCCRM_SalesExport_${t}] AS ${archived};`;
  return `CREATE VIEW dbo.[SCCRM_SalesExport_${t}] AS ${archived} WHERE h.source_lane='archive'
  ${['001','002'].map(pos=>`UNION ALL SELECT ${cols} FROM dbo.[${ACTIVE[t]}${pos}] d JOIN dbo.SCCRM_SalesFinalHeaders h ON h.FTShdDocNo=d.FTShdDocNo AND h.source_lane='${pos}'`).join('\n')};`;
 })];
}
function receiver(s,database){
 if(database!=='AdaAcc'&&!/^SCCRM_SalesLab_20261111_000$/.test(database))throw Error('SALES_TARGET_DB_REFUSED');
 const parts=[];
 for(let i=0;i<TABLES.length;i++){
  const t=TABLES[i],cols=s.columns.filter(c=>c.table_name===t),names=cols.map(c=>`[${c.column_name}]`).join(',');
  parts.push(`SELECT TOP(0) ${names} INTO #T${i} FROM dbo.[${t}];
 INSERT #T${i}(${names}) SELECT ${cols.map(c=>`CASE WHEN n.exist('${c.column_name}[@null="1"]')=1 THEN NULL ELSE n.value('(${c.column_name})[1]','${sqlType(c)}') END`).join(',')}
 FROM @xml.nodes('/receipt/${t}/r') r(n);
 IF(SELECT COUNT(*) FROM #T${i})>1000 OR EXISTS(SELECT 1 FROM #T${i} WHERE FTShdDocNo<>@doc OR FTShdDocNo IS NULL) RAISERROR('SALES_PACKET_IDENTITY_REFUSED',16,1);`);
  if(cols.some(c=>c.column_name==='FTBchCode'))parts.push(`IF EXISTS(SELECT 1 FROM #T${i} WHERE FTBchCode<>@branch OR FTBchCode IS NULL) RAISERROR('SALES_PACKET_BRANCH_REFUSED',16,1);`);
 }
 const comparisons=TABLES.map((t,i)=>{
  const cols=s.columns.filter(c=>c.table_name===t&&!IGNORE.has(c.column_name));const list=cols.map(c=>`CONVERT(varbinary(max),[${c.column_name}])`).join(',');
  return `IF (SELECT COUNT(*) FROM #T${i})<>(SELECT COUNT(*) FROM dbo.[${t}] WHERE FTShdDocNo=@doc)
 OR EXISTS(SELECT ${list} FROM #T${i} EXCEPT SELECT ${list} FROM dbo.[${t}] WHERE FTShdDocNo=@doc)
 OR EXISTS(SELECT ${list} FROM dbo.[${t}] WHERE FTShdDocNo=@doc EXCEPT SELECT ${list} FROM #T${i}) RAISERROR('SALES_EXISTING_RECORD_DIFFERENT',16,1);`;
 }).join('\n');
 return `CREATE PROCEDURE dbo.SCCRM_SalesApply @Id uniqueidentifier,@Lease uniqueidentifier WITH EXECUTE AS OWNER AS
 BEGIN SET NOCOUNT ON;SET XACT_ABORT ON;SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 750;
 IF DB_NAME()<>'${database}' OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesMeta WHERE marker='${MARKER}' AND schema_hash='${s.hash}') BEGIN RAISERROR('SALES_TARGET_REFUSED',16,1);RETURN;END;
 DECLARE @doc varchar(20),@branch char(3),@packet nvarchar(max),@hash char(64),@xml xml,@resource nvarchar(255),@rc int,@outcome varchar(40),@rows int,@memberPending bit,@code varchar(80);
 BEGIN TRY BEGIN TRANSACTION;
 SELECT @doc=doc_no,@branch=branch_code,@packet=packet,@hash=payload_hash FROM dbo.SCCRM_SalesJobs WITH(UPDLOCK,ROWLOCK)
 WHERE id=@Id AND lease_token=@Lease AND state='running' AND lease_until>GETUTCDATE();
 IF @doc IS NULL OR @packet IS NULL RAISERROR('SALES_LEASE_OR_PACKET_REQUIRED',16,1);
 IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesSources WHERE branch_code=@branch AND enabled=1) RAISERROR('SALES_SOURCE_PAUSED',16,1);
 IF EXISTS(SELECT 1 FROM sys.triggers tr JOIN sys.tables t ON t.object_id=tr.parent_id WHERE tr.is_disabled=0 AND t.name IN(${TABLES.map(t=>`'${t}'`).join(',')})) RAISERROR('SALES_NATIVE_TRIGGER_REVIEW',16,1);
 SET @resource='SCCRM-Receipt-'+@branch+'-'+@doc;EXEC @rc=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=0;
 IF @rc<0 RAISERROR('SALES_RECEIPT_BUSY',16,1);
 SET @xml=CONVERT(xml,@packet,1);
 IF @xml.value('(/receipt/@schema)[1]','varchar(64)')<>'${s.hash}' OR @xml.value('(/receipt/@doc)[1]','varchar(20)')<>@doc
 OR @xml.value('(/receipt/@branch)[1]','varchar(3)')<>@branch RAISERROR('SALES_PACKET_IDENTITY_REFUSED',16,1);
 ${parts.join('\n')}
 IF(SELECT COUNT(*) FROM #T0)<>1 OR NOT EXISTS(SELECT 1 FROM #T0 WHERE FTShdDocNo=@doc AND FTBchCode=@branch AND FTPosCode=SUBSTRING(@doc,9,3)
 AND FTShdStaPaid='3' AND FTShdStaDoc='1' AND FTShdDocType=CASE WHEN LEFT(@doc,1)='R' THEN '9' ELSE '1' END AND FCShdGrand IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM #T1) RAISERROR('SALES_HEADER_NOT_FINAL',16,1);
 SET @memberPending=0;
 IF EXISTS(SELECT 1 FROM #T0 h WHERE NULLIF(LTRIM(RTRIM(ISNULL(h.FTCstCode,''))),'') IS NOT NULL AND h.FTCstCode<>'0'
 AND NOT EXISTS(SELECT 1 FROM dbo.TCNMCst c WHERE c.FTCstCode=h.FTCstCode)) SET @memberPending=1;
 SET @outcome='restored_original';SET @rows=0;
 IF EXISTS(SELECT 1 FROM dbo.SCCRM_SalesJournal WHERE branch_code=@branch AND doc_no=@doc)
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesJournal WHERE branch_code=@branch AND doc_no=@doc AND payload_hash=@hash) RAISERROR('SALES_JOURNAL_IDENTITY_CHANGED',16,1);
  SET @outcome='replayed';
 END ELSE BEGIN
  IF EXISTS(SELECT 1 FROM dbo.TPSTSalHD WITH(UPDLOCK,HOLDLOCK) WHERE FTShdDocNo=@doc)
  BEGIN ${comparisons} SET @outcome='existing_verified';END
  ELSE BEGIN
   ${TABLES.map((t,i)=>`IF EXISTS(SELECT 1 FROM dbo.[${t}] WHERE FTShdDocNo=@doc) RAISERROR('SALES_PARTIAL_DESTINATION',16,1);`).join('\n')}
   ${TABLES.map((t,i)=>{const n=s.columns.filter(c=>c.table_name===t).map(c=>`[${c.column_name}]`).join(',');return `INSERT dbo.[${t}](${n}) SELECT ${n} FROM #T${i};SET @rows=@rows+@@ROWCOUNT;`;}).join('\n')}
   ${comparisons}
  END;
  INSERT dbo.SCCRM_SalesJournal(branch_code,doc_no,job_id,payload_hash,outcome,inserted_rows,committed_at) VALUES(@branch,@doc,@Id,@hash,@outcome,@rows,GETUTCDATE());
 END;
 SET @code=CASE WHEN @memberPending=1 THEN 'SALES_VERIFIED_MEMBER_PENDING' ELSE 'SALES_VERIFIED' END;
 UPDATE dbo.SCCRM_SalesJobs SET state='succeeded',last_code=@code,lease_token=NULL,lease_until=NULL,completed_at=GETUTCDATE(),updated_at=GETUTCDATE() WHERE id=@Id;
 INSERT dbo.SCCRM_SalesEvents(job_id,state,code,occurred_at)VALUES(@Id,'succeeded',@code,GETUTCDATE());
 COMMIT TRANSACTION;SELECT @Id id,@doc doc_no,@branch branch_code,@outcome outcome,@rows inserted_rows;
 END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION;DECLARE @error nvarchar(2048);SET @error=CASE WHEN ERROR_NUMBER() IN(2601,2627) THEN 'SALES_NATIVE_KEY_COLLISION' ELSE ERROR_MESSAGE() END;RAISERROR(@error,16,1);END CATCH;
 END;`;
}
module.exports={TABLES,MARKER,SCOPE,ACTIVE,IGNORE,schema,sqlType,nativeTableDdl,sourceViews,receiver};
