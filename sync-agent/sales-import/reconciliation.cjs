'use strict';
// Explicit operator reconciliation only; the automatic receiver stays strict.
const crypto=require('node:crypto');
const {TABLES,IGNORE,MARKER,SCOPE,schema}=require('./schema.cjs');
const DEFAULT_FIELDS=new Set(`FTSplCode FTAreCode FTSpnCode FTShpCode FTShdRefExt FTShdRefInt FTShdRefAE FTShdCtrName FTShdStaPost FTPjcCode FTAloCode FTCcyCode FTShdRmk FTXbhDocNo FTXphDocNo FTShdUsrEnter FTShdUsrPacker FTShdUsrSender FTShdTnfID FTShdVehID FTDocControl FTXqhDocNoRef FTCstStaClose FTShdBchFrm FTShdBchTo FTShdWahFrm FTShdWahTo FCShdDiscGP1 FCShdDiscGP2 FCShdB4VatAfGP1 FCShdB4VatAfGP2 FTShdDocRefMin FTShdDocRefMax FTRteCode FCShdRteFac FTCtrCardID FTPmhCode FTSdtStaRfd FTAccCode FTSdtPdtParent FCSdtQtySet FCSdtQtyLef FCSdtQtyRfn FCPdtLeftPO FTCpnCode FCSdtQtySale FCSdtQtyRet FCSdtQtyCN FCSdtQtyAvi FCSdtB4VatAfGP1 FCSdtB4VatAfGP2 FCSdtDisShp FCSdtShrDisShp FCSdtSetPriceAvg FCSdtSetPriceRte FTSdtDisChgTxtRte FCSdtDisRte FTSdtStaOver FTSdtRmk FTSrcRef FTBnkCode FTBnkName FTSrcBnkBch FCSrcCardChg FTXrcRmk FTSrcRetDocRef FCSrcRetAmt FCSdtDisAvg FCSdtFootAvg FCSdtRePackAvg FTShdPosCN FTShdRefSaleTax FCSrcRteAmt FCSrcRteFac FTShdApvCode`.split(/\s+/));
const INVOICE_FIELDS=new Set(['FTShdApvCode','FTShdStaVatUpld','FTShdDocVatFull','FTShdCstName','FTShdCstAddr']);
const KEYS={TPSTSalHD:['FTShdDocNo'],TPSTSalDT:['FTShdDocNo','FNSdtSeqNo'],TPSTSalRC:['FTShdDocNo','FNSrcSeqNo'],TPSTSalPD:['FTShdDocNo','FTPmhCode','FTSpdGrpName','FTSpdBarCode','FNSdtSeqNo'],TPSTSalPG:['FTShdDocNo','FTPmhCode','FTSpgGrpName'],TPSTSalPH:['FTShdDocNo','FTPmhCode'],TPSTSalInvCsm:['FTShdDocNo','FNSicSeqNo','FTPdtCode'],TPSTVoidDT:['FTVidSeq','FNSdtSeqNo']};
function requireValue(v,code){if(!v)throw Error(code);}
function classify(differences,columns){
 if(!differences.length)return 'exact';
 const byName=new Map(columns.map(c=>[c.table_name+'.'+c.column_name,c]));
 const defaults=differences.every(d=>{const c=byName.get(d.table+'.'+d.column);return c?.is_nullable&&DEFAULT_FIELDS.has(d.column)&&d.source===null&&((c.type_name==='varchar'&&d.hq==='')||(['float','int','bigint'].includes(c.type_name)&&typeof d.hq==='string'&&/^0+$/.test(d.hq)));});
 if(defaults)return 'legacy_defaults';
 if(differences.every(d=>d.table==='TPSTSalHD'&&INVOICE_FIELDS.has(d.column)&&d.hq===null&&typeof d.source==='string'))return 'invoice_fill';
 return 'review';
}
function namesFor(columns,t){return columns.filter(c=>c.table_name===t&&!IGNORE.has(c.column_name)).map(c=>c.column_name);}
function rowHash(row,names){
 const text=names.map(n=>row[n]===null?'N;':`V${row[n].length/2}:${row[n]};`).join('');
 requireValue(Buffer.byteLength(text,'ascii')<=8000,'RECON_SQL2008_HASH_LIMIT');
 // SQL Server 2008 supports SHA1 only. This is a transactional change detector;
 // durable external evidence uses SHA256 and the pinned administrative scope.
 return crypto.createHash('sha1').update(text,'ascii').digest('hex');
}
function sqlHash(names){return "HASHBYTES('SHA1',CONVERT(varchar(max),'')+"+names.map(n=>`CASE WHEN [${n}] IS NULL THEN 'N;' ELSE 'V'+CONVERT(varchar(20),DATALENGTH(CONVERT(varbinary(max),[${n}])))+':'+CONVERT(varchar(max),CONVERT(varbinary(max),[${n}]),2)+';' END`).join('+')+')';}
function literal(s){return "'"+String(s).replaceAll("'","''")+"'";}
function expectedRows(snapshot,jobs,columns){
 const docs=new Set(jobs.map(j=>j.doc)),rows=[];
 for(const t of TABLES){const names=namesFor(columns,t),counts=new Map();for(const row of snapshot.tables[t])if(docs.has(row.__doc)){const key=row.__doc+'|'+rowHash(row,names);counts.set(key,(counts.get(key)||0)+1);}for(const [key,count]of counts){const [doc,hash]=key.split('|');rows.push(`(${literal(t)},${literal(doc)},0x${hash},${count})`);}}
 return rows;
}
function buildResolutionSql({database,columns,jobs,hq,source,runId,observedAt}){
 requireValue(database==='AdaAcc'||database==='SCCRM_SalesLab_20261111_000','RECON_DATABASE_REFUSED');
 const s=schema({columns});requireValue(jobs.length>0&&jobs.length<=50,'RECON_BATCH_REFUSED');
 requireValue(/^[a-f0-9-]{36}$/.test(runId)&&!Number.isNaN(Date.parse(observedAt)),'RECON_AUDIT_REQUIRED');
 requireValue(new Set(jobs.map(j=>j.id)).size===jobs.length,'RECON_DUPLICATE_JOB');
 for(const j of jobs){requireValue(/^[a-f0-9-]{36}$/i.test(j.id)&&/^[SR]2611(001|003|004|005)00[12]-\d{7}$/.test(j.doc)&&j.doc.slice(5,8)===j.branch,'RECON_JOB_REFUSED');requireValue(['exact','legacy_defaults','invoice_fill'].includes(j.method),'RECON_UNRESOLVED_JOB');requireValue(classify(j.differences,columns)===j.method,'RECON_METHOD_REFUSED');requireValue(/^[a-f0-9]{64}$/.test(j.sourceHash)&&/^[a-f0-9]{64}$/.test(j.hqHash),'RECON_HASH_REQUIRED');}
 const docs=jobs.map(j=>literal(j.doc)).join(','),expected=expectedRows(hq,jobs,columns);
 let sql=`SET NOCOUNT ON;SET XACT_ABORT ON;SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 750;BEGIN TRY
IF DB_NAME()<>${literal(database)} OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesMeta WHERE marker='${MARKER}' AND schema_hash='${s.hash}' AND scope='${SCOPE}') RAISERROR('RECON_OWNER_REFUSED',16,1);
IF DATEDIFF(second,CONVERT(datetime,${literal(observedAt.slice(0,23))},126),GETUTCDATE()) NOT BETWEEN 0 AND 600 RAISERROR('RECON_EVIDENCE_EXPIRED',16,1);
IF OBJECT_ID('dbo.SCCRM_SalesReviewResolutions') IS NULL RAISERROR('RECON_AUDIT_TABLE_REQUIRED',16,1);
BEGIN TRANSACTION;
CREATE TABLE #Expected(t varchar(32),doc varchar(20),h binary(20),n int);
CREATE TABLE #Actual(t varchar(32),doc varchar(20),h binary(20),n int);
`;
 for(let i=0;i<expected.length;i+=500)sql+='INSERT #Expected VALUES'+expected.slice(i,i+500).join(',')+';\n';
 for(const t of TABLES)sql+=`INSERT #Actual SELECT ${literal(t)},d,h,COUNT(*) FROM(SELECT FTShdDocNo d,${sqlHash(namesFor(columns,t))} h FROM dbo.[${t}] WITH(HOLDLOCK) WHERE FTShdDocNo IN(${docs})) x GROUP BY d,h;\n`;
 sql+="IF EXISTS(SELECT * FROM #Expected EXCEPT SELECT * FROM #Actual) OR EXISTS(SELECT * FROM #Actual EXCEPT SELECT * FROM #Expected) RAISERROR('RECON_NATIVE_CHANGED',16,1);\n";
 for(const j of jobs){
  const oldHash=j.oldHash?`payload_hash=${literal(j.oldHash)}`:'payload_hash IS NULL';
  sql+=`IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesJobs WITH(UPDLOCK,HOLDLOCK) WHERE id='${j.id}' AND branch_code='${j.branch}' AND doc_no=${literal(j.doc)} AND state='review' AND last_code=${literal(j.oldCode)} AND ${oldHash} AND lease_token IS NULL) RAISERROR('RECON_JOB_CHANGED',16,1);
IF EXISTS(SELECT 1 FROM dbo.SCCRM_SalesJournal WHERE job_id='${j.id}' OR(branch_code='${j.branch}' AND doc_no=${literal(j.doc)})) OR EXISTS(SELECT 1 FROM dbo.SCCRM_SalesReviewResolutions WHERE job_id='${j.id}') RAISERROR('RECON_ALREADY_RESOLVED',16,1);
`;
  if(j.method==='invoice_fill'){
   requireValue(source,'RECON_SOURCE_REQUIRED');
   requireValue(!j.differences.some(d=>!INVOICE_FIELDS.has(d.column)),'RECON_INVOICE_SCOPE_REFUSED');
   sql+="IF EXISTS(SELECT 1 FROM sys.triggers WHERE parent_id=OBJECT_ID('dbo.TPSTSalHD') AND is_disabled=0) RAISERROR('RECON_TRIGGER_REFUSED',16,1);\n";
   sql+=`UPDATE dbo.TPSTSalHD SET ${j.differences.map(d=>{const c=columns.find(c=>c.table_name===d.table&&c.column_name===d.column);requireValue(c?.type_name==='varchar'&&c.max_length>0&&/^(?:[A-F0-9]{2})*$/.test(d.source),'RECON_INVOICE_TYPE_REFUSED');return `[${d.column}]=CONVERT(varchar(${c.max_length}),0x${d.source})`;}).join(',')} WHERE FTShdDocNo=${literal(j.doc)};IF @@ROWCOUNT<>1 RAISERROR('RECON_INVOICE_ROW_REQUIRED',16,1);
IF NOT EXISTS(SELECT 1 FROM dbo.TPSTSalHD WHERE FTShdDocNo=${literal(j.doc)} AND ${sqlHash(namesFor(columns,'TPSTSalHD'))}=0x${rowHash(source.tables.TPSTSalHD.find(r=>r.__doc===j.doc),namesFor(columns,'TPSTSalHD'))}) RAISERROR('RECON_INVOICE_READBACK_FAILED',16,1);
`;
  }
  const outcome=j.method==='invoice_fill'?'existing_invoice_filled':j.method==='legacy_defaults'?'existing_legacy_defaults':'existing_verified';
  sql+=`INSERT dbo.SCCRM_SalesReviewResolutions(job_id,run_id,method,source_hash,hq_before_hash,evidence_observed_at,resolved_at,changed_native_fields) VALUES('${j.id}','${runId}',${literal(j.method)},'${j.sourceHash}','${j.hqHash}',CONVERT(datetime,${literal(observedAt.slice(0,23))},126),GETUTCDATE(),${j.method==='invoice_fill'?j.differences.length:0});
INSERT dbo.SCCRM_SalesJournal(branch_code,doc_no,job_id,payload_hash,outcome,inserted_rows,committed_at) VALUES('${j.branch}',${literal(j.doc)},'${j.id}','${j.oldHash||j.sourceHash}','${outcome}',0,GETUTCDATE());
UPDATE dbo.SCCRM_SalesJobs SET state='succeeded',last_code='SALES_RECONCILED_${j.method.toUpperCase()}',completed_at=GETUTCDATE(),updated_at=GETUTCDATE(),lease_token=NULL,lease_until=NULL WHERE id='${j.id}';
INSERT dbo.SCCRM_SalesEvents(job_id,state,code,occurred_at) VALUES('${j.id}','succeeded','SALES_RECONCILED_${j.method.toUpperCase()}',GETUTCDATE());
`;
 }
 sql+=`COMMIT TRANSACTION;SELECT ${jobs.length} resolved;END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION;DECLARE @error nvarchar(2048);SET @error=ERROR_MESSAGE();RAISERROR(@error,16,1);END CATCH;`;
 return sql;
}
function auditTableSql(database,schemaHash){requireValue(database==='AdaAcc'||database==='SCCRM_SalesLab_20261111_000','RECON_DATABASE_REFUSED');requireValue(/^[a-f0-9]{64}$/.test(schemaHash),'RECON_SCHEMA_REQUIRED');return `IF DB_NAME()<>${literal(database)} OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesMeta WHERE marker='${MARKER}' AND schema_hash='${schemaHash}') BEGIN RAISERROR('RECON_OWNER_REFUSED',16,1);RETURN;END;
IF OBJECT_ID('dbo.SCCRM_SalesReviewResolutions') IS NULL CREATE TABLE dbo.SCCRM_SalesReviewResolutions(job_id uniqueidentifier PRIMARY KEY,run_id uniqueidentifier NOT NULL,method varchar(30) NOT NULL,source_hash char(64) NOT NULL,hq_before_hash char(64) NOT NULL,evidence_observed_at datetime NOT NULL,resolved_at datetime NOT NULL,changed_native_fields int NOT NULL,FOREIGN KEY(job_id) REFERENCES dbo.SCCRM_SalesJobs(id));`;}
module.exports={classify,rowHash,sqlHash,expectedRows,buildResolutionSql,auditTableSql,DEFAULT_FIELDS,INVOICE_FIELDS,KEYS,namesFor};
