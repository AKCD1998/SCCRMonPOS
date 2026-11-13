'use strict';
// Admin-only maintenance. Contact aliases do not change assignment profiles,
// login phones, customer codes, receipt owners or any point balance.
const crypto=require('node:crypto');
const MARKER='cd0f846f-1dc1-4bb8-91a1-9345c8471156';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function requireValue(ok,code){if(!ok)throw Error(code);}
function validate(input){
 requireValue(input&&/^[a-f0-9-]{36}$/.test(input.memberId||'')&&/^AR000-\d{6}$/.test(input.adaCode||''),'CONTACT_IDENTITY_REFUSED');
 requireValue(/^0\d{9}$/.test(input.primaryPhone||'')&&/^0\d{8,9}$/.test(input.alternatePhone||'')&&input.primaryPhone!==input.alternatePhone,'CONTACT_PHONE_REFUSED');
 requireValue(typeof input.approvalReference==='string'&&input.approvalReference.trim().length>0&&input.approvalReference.length<=180,'CONTACT_APPROVAL_REQUIRED');
 return {...input,nativePhone:input.primaryPhone+';'+input.alternatePhone};
}
function replaceOne(sql,from,to){requireValue(sql.split(from).length===2,'CONTACT_PROCEDURE_VERSION_REFUSED');return sql.replace(from,to);}
function patchProcedure(name,sql){
 requireValue(typeof sql==='string'&&!sql.includes('SCCRM_ContactPhoneMatches'),'CONTACT_PROCEDURE_VERSION_REFUSED');
 if(name==='SCCRM_CreateMemberFromSccrmV2'||name==='SCCRM_GetAssignedCustomerSnapshot'){
  sql=replaceOne(sql,"CONVERT(varbinary(max),ISNULL(c.FTCstTel,''))=CONVERT(varbinary(max),a.profile_phone)",
   "dbo.SCCRM_ContactPhoneMatches(a.member_id,a.ada_code,ISNULL(c.FTCstTel,''),a.profile_phone)=1");
  if(name==='SCCRM_GetAssignedCustomerSnapshot')sql=replaceOne(sql,'c.[FTCstTel]','a.profile_phone AS [FTCstTel]');
 }else if(name==='SCCRM_ReceiveAssignedMember'){
  // Only the existing receipt replay check. The separate legacy migration guard
  // remains byte exact and is not authorized by a contact approval.
  const end=sql.indexOf("SET @Outcome='existing'");requireValue(end>0,'CONTACT_PROCEDURE_VERSION_REFUSED');
  const replay=replaceOne(sql.slice(0,end),"CONVERT(varbinary(max),ISNULL(c.FTCstTel,''))=CONVERT(varbinary(max),@Phone)",
   "dbo.SCCRM_ContactPhoneMatches(r.member_id,r.ada_code,ISNULL(c.FTCstTel,''),@Phone)=1");
  sql=replay+sql.slice(end);
  sql=replaceOne(sql,'c.FTCstTel profile_phone','a.profile_phone profile_phone');
 }else if(name==='SCCRM_AttachReceiptMember'||name==='SCCRM_ReadReceiptSnapshot'){
  sql=replaceOne(sql,"ISNULL(LTRIM(RTRIM(FTCstTel)),'')=@ExpectedPhone",
   "dbo.SCCRM_ContactPhoneMatches((SELECT member_id FROM dbo.SCCRM_ContactPhones WHERE ada_code=@AdaCode),@AdaCode,ISNULL(LTRIM(RTRIM(FTCstTel)),''),@ExpectedPhone)=1");
 }else throw Error('CONTACT_PROCEDURE_NAME_REFUSED');
 requireValue(/^\s*CREATE\s+PROCEDURE\s+dbo\./i.test(sql),'CONTACT_PROCEDURE_DDL_REFUSED');
 return sql.replace(/CREATE\s+PROCEDURE/i,'ALTER PROCEDURE');
}
const schema=`CREATE TABLE dbo.SCCRM_ContactPhonesMeta(singleton tinyint NOT NULL PRIMARY KEY CHECK(singleton=1),marker uniqueidentifier NOT NULL);
INSERT dbo.SCCRM_ContactPhonesMeta VALUES(1,'${MARKER}');
CREATE TABLE dbo.SCCRM_ContactPhones(
 member_id uniqueidentifier NOT NULL PRIMARY KEY,ada_code varchar(20) NOT NULL UNIQUE,
 primary_phone varchar(10) NOT NULL,alternate_phone varchar(10) NOT NULL,native_phone varchar(50) NOT NULL,
 approval_reference nvarchar(180) NOT NULL,approved_at datetime NOT NULL DEFAULT GETUTCDATE(),
 CHECK(DATALENGTH(primary_phone)=10 AND primary_phone COLLATE Latin1_General_BIN NOT LIKE '%[^0-9]%'),
 CHECK(DATALENGTH(alternate_phone) IN(9,10) AND alternate_phone COLLATE Latin1_General_BIN NOT LIKE '%[^0-9]%'),
 CHECK(CONVERT(varbinary(50),native_phone)=CONVERT(varbinary(50),primary_phone+';'+alternate_phone))
);`;
const matcher=`CREATE FUNCTION dbo.SCCRM_ContactPhoneMatches(@MemberId uniqueidentifier,@Code varchar(20),@Native varchar(50),@Primary varchar(30))
RETURNS bit AS BEGIN
 IF CONVERT(varbinary(max),@Native)=CONVERT(varbinary(max),@Primary) RETURN 1;
 IF EXISTS(SELECT 1 FROM dbo.SCCRM_ContactPhones p WHERE p.member_id=@MemberId
  AND CONVERT(varbinary(max),p.ada_code)=CONVERT(varbinary(max),@Code)
  AND CONVERT(varbinary(max),p.primary_phone)=CONVERT(varbinary(max),@Primary)
  AND CONVERT(varbinary(max),p.native_phone)=CONVERT(varbinary(max),@Native)) RETURN 1;
 RETURN 0;
END;`;
function literal(s){return "N'"+String(s).replaceAll("'","''")+"'";}
function applySql(raw){
 const ansi=s=>literal(s).slice(1);
 const p=validate(raw),id=ansi(p.memberId),code=ansi(p.adaCode),primary=ansi(p.primaryPhone),alternate=ansi(p.alternatePhone),native=ansi(p.nativePhone),approval=literal(p.approvalReference);
 return `SET NOCOUNT ON;SET XACT_ABORT ON;SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;
BEGIN TRY
 BEGIN TRAN;
 IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_ContactPhonesMeta WHERE singleton=1 AND marker='${MARKER}') RAISERROR('CONTACT_SCHEMA_REFUSED',16,1);
 IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeAssignments WHERE member_id=${id} AND ada_code=${code} AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),${primary}))
 AND NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeApprovals WHERE member_id=${id} AND ada_code=${code} AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),${primary})) RAISERROR('CONTACT_ASSIGNMENT_REFUSED',16,1);
 IF EXISTS(SELECT 1 FROM dbo.SCCRM_ContactPhones WITH(UPDLOCK,HOLDLOCK) WHERE member_id=${id} OR ada_code=${code})
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_ContactPhones WHERE member_id=${id} AND ada_code=${code}
    AND CONVERT(varbinary(max),primary_phone)=CONVERT(varbinary(max),${primary})
    AND CONVERT(varbinary(max),alternate_phone)=CONVERT(varbinary(max),${alternate})
    AND CONVERT(varbinary(max),native_phone)=CONVERT(varbinary(max),${native})
    AND CONVERT(varbinary(max),approval_reference)=CONVERT(varbinary(max),${approval})) RAISERROR('CONTACT_APPROVAL_CONFLICT',16,1);
 END
 ELSE INSERT dbo.SCCRM_ContactPhones(member_id,ada_code,primary_phone,alternate_phone,native_phone,approval_reference) VALUES(${id},${code},${primary},${alternate},${native},${approval});
 IF NOT EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK) WHERE FTCstCode=${code} AND FTCstStaActive='1'
    AND (CONVERT(varbinary(max),FTCstTel)=CONVERT(varbinary(max),${primary}) OR CONVERT(varbinary(max),FTCstTel)=CONVERT(varbinary(max),${native}))) RAISERROR('CONTACT_NATIVE_CHANGED',16,1);
 UPDATE dbo.TCNMCst SET FTCstTel=${native} WHERE FTCstCode=${code} AND CONVERT(varbinary(max),FTCstTel)=CONVERT(varbinary(max),${primary});
 COMMIT;
 SELECT FTCstCode,FTCstTel FROM dbo.TCNMCst WHERE FTCstCode=${code};
END TRY BEGIN CATCH
 IF XACT_STATE()<>0 ROLLBACK;
 DECLARE @Error nvarchar(4000);SET @Error=ERROR_MESSAGE();RAISERROR(@Error,16,1);
END CATCH;`;
}
function installSql(procedures,scope){
 requireValue(scope&&/^[a-f0-9-]{36}$/.test(scope.marker||'')&&['hq','branch'].includes(scope.role),'CONTACT_SCOPE_REQUIRED');
 const expected=(scope.role==='hq'?['SCCRM_CreateMemberFromSccrmV2','SCCRM_GetAssignedCustomerSnapshot']:['SCCRM_ReceiveAssignedMember']).concat(['SCCRM_AttachReceiptMember','SCCRM_ReadReceiptSnapshot']);
 requireValue(expected.every(name=>typeof procedures[name]==='string'),'CONTACT_PROCEDURES_REQUIRED');
 const patches=expected.map(name=>({name,original:procedures[name],patched:patchProcedure(name,procedures[name])}));
 return `SET NOCOUNT ON;SET XACT_ABORT ON;SET LOCK_TIMEOUT 1000;
BEGIN TRY BEGIN TRAN;
 IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeScope WHERE marker='${scope.marker}' AND role='${scope.role}' AND database_name=DB_NAME() AND machine_name=CONVERT(nvarchar(128),SERVERPROPERTY('MachineName'))) RAISERROR('CONTACT_TARGET_SCOPE_REFUSED',16,1);
 IF OBJECT_ID('dbo.SCCRM_ContactPhonesMeta') IS NOT NULL OR OBJECT_ID('dbo.SCCRM_ContactPhones') IS NOT NULL OR OBJECT_ID('dbo.SCCRM_ContactPhoneMatches') IS NOT NULL RAISERROR('CONTACT_INSTALL_ALREADY_PRESENT_REVIEW',16,1);
 ${patches.map(p=>`IF OBJECT_DEFINITION(OBJECT_ID('dbo.${p.name}')) IS NULL OR CONVERT(varbinary(max),CONVERT(nvarchar(max),OBJECT_DEFINITION(OBJECT_ID('dbo.${p.name}'))))<>CONVERT(varbinary(max),CONVERT(nvarchar(max),${literal(p.original)})) RAISERROR('CONTACT_PROCEDURE_CHANGED',16,1);`).join('\n')}
 ${schema}
 EXEC(${literal(matcher)});
 ${patches.map(p=>'EXEC('+literal(p.patched)+');').join('\n')}
 COMMIT;
 SELECT '${MARKER}' installed_marker;
END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK;DECLARE @Error nvarchar(4000);SET @Error=ERROR_MESSAGE();RAISERROR(@Error,16,1);END CATCH;`;
}
module.exports={MARKER,hash,validate,patchProcedure,schema,matcher,applySql,installSql};
