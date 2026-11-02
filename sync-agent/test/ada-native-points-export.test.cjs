'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const test=require('node:test'),assert=require('node:assert/strict');
const source=require('../points/export.cjs');
const script=path.join(source.ROOT,'Read-NativePoints.ps1');
test('export requires an explicit reviewed mode before reading credentials or sources',async()=>{await assert.rejects(source.exportAll({mode:'Production'}),/POINT_EXPORT_EXPLICIT_SCOPE_REQUIRED/);await assert.rejects(source.readSnapshot('002'),/POINT_EXPORT_TARGET_REFUSED/);await assert.rejects(source.readSnapshot('001',{mode:'Copy'}),/POINT_EXPORT_TARGET_REFUSED/);});
test('private exports cannot be redirected outside their owned runtime tree',()=>{assert.throws(()=>source.privateRuntime(path.join(source.ROOT,'..','other')),/POINT_EXPORT_PRIVATE_PATH_REQUIRED/);});
test('read-only PowerShell has static SQL and excludes customer identifiers beyond the approved code/point projection',()=>{
 const s=fs.readFileSync(script,'utf8');assert.match(s,/CommandTimeout=8/);assert.match(s,/SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW/);assert.match(s,/OPTION\(MAXDOP 1\)/);assert.doesNotMatch(s,/\$p\.(sql|query|action)\b/i);assert.doesNotMatch(s,/SELECT\s+\*/i);
 const customerStatement=s.split(/\r?\n/).find(l=>l.includes('FROM dbo.TCNMCst ORDER BY'));
 assert.match(customerStatement,/FTCstCode,FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint/);assert.doesNotMatch(customerStatement,/Pin|Name|Tel|Email|DOB/i);
 assert.match(s,/\[long\]/);assert.match(s,/ToString\('R'/);assert.doesNotMatch(s,/ToString\('yyyy-MM-ddTHH:mm:ss\.fff'[^\n]*\+\s*'Z'/);
});
test('PowerShell rejects an unapproved target before connection and never echoes supplied credentials',{skip:process.platform!=='win32'},()=>{
 const packet={scope:source.SCOPE,branch:'999',admin:{user:'synthetic',password:'synthetic-secret-never-log'}};
 const p=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-Mode','Live'],{input:JSON.stringify(packet),encoding:'utf8',timeout:10000,windowsHide:true});
 assert.notEqual(p.status,0);assert.equal(p.stderr,'');assert.doesNotMatch(p.stdout,/synthetic-secret-never-log/);const r=JSON.parse(p.stdout.trim().replace(/^\uFEFF/,''));assert.equal(r.code,'POINT_EXPORT_SCOPE_REFUSED');assert.equal(r.productionWrites,0);assert.equal(r.pinRead,false);
});
test('PowerShell denies production database names in Copy mode before connection',{skip:process.platform!=='win32'},()=>{
 const p=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-Mode','Copy'],{input:JSON.stringify({scope:source.SCOPE,branch:'000',database:'AdaAcc'}),encoding:'utf8',timeout:10000,windowsHide:true});
 assert.notEqual(p.status,0);assert.equal(JSON.parse(p.stdout.trim().replace(/^\uFEFF/,'')).code,'POINT_EXPORT_COPY_DATABASE_REFUSED');
});
test('private runtime ACL preparation is repeatable without requesting owner or audit privileges',{skip:process.platform!=='win32'},()=>{
 const first=source.privateRuntime(),second=source.privateRuntime();assert.equal(first,second);
 const text=fs.readFileSync(path.join(source.ROOT,'Prepare-PrivateRuntime.ps1'),'utf8');assert.match(text,/AccessControlSections\]::Access/);assert.doesNotMatch(text,/SetOwner|SetGroup|AuditRule|SeSecurityPrivilege/);
});
function schemaFixture(){
 const points=require('../points/model.cjs').POINT_FIELDS;
 const master=['FTCstCode','FCCstRetPoint','FCCstRetAmt','FCCstWhsPoint','FCCstDailyPoint','FTBchCode','FDCstLastPoint','FDDateUpd','FTTimeUpd'];
 const floats=new Set(['FCCstRetPoint','FCCstRetAmt','FCCstWhsPoint','FCCstDailyPoint','FCPntPointbyOne','FCPntAmtRcv']);
 const dates=new Set(['FDPntDate','FDPntSplStart','FDPntSplExpired','FDCstLastPoint','FDDateUpd','FDDateIns']);
 const sizes={FTBchCode:6,FTCstCode:20,FTPntRefDoc:30,FTSplCode:20,FTPntExpired:1,FTPntStaPrcDoc:1,FTPntCardType:1,FTCptJDate:6,FTCptTime:8,FTPntStaExpired:1,FTTimeUpd:8,FTWhoUpd:50,FTTimeIns:8,FTWhoIns:50};
 const columns=[];
 for(const [object,names]of Object.entries({TCNMCst:master,TCNTCstPoint:points,VCN_TCNMPdtCstPointAmt:['FTCstCode','FNPntPoint','FCPntAmtRcv']}))for(const name of names){
  const type=object==='VCN_TCNMPdtCstPointAmt'&&name!=='FTCstCode'?'float':floats.has(name)?'float':dates.has(name)?'datetime':['FNPntPoint','FNPntPointOld'].includes(name)?'bigint':'varchar';
  columns.push({object_name:object,name,data_type:type,max_length:type==='varchar'?(object==='TCNMCst'&&name==='FTBchCode'?3:sizes[name]):8,precision:type==='float'?53:type==='datetime'?23:type==='bigint'?19:0,scale:type==='datetime'?3:0});
 }
 return {columns,pointPrimaryKey:['FTBchCode','FTCstCode','FTPntRefDoc','FTSplCode'].map((name,i)=>({name,key_ordinal:i+1})),viewDefinition:fs.readFileSync(path.join(source.ROOT,'native-view.sql'),'utf8'),viewHash:source.VIEW_HASH};
}
test('schema guard distinguishes the 3-character customer home branch from the 6-character point origin',()=>{
 const s=schemaFixture();assert.match(source.validateSchema(s),/^[a-f0-9]{64}$/);s.columns.find(c=>c.object_name==='TCNMCst'&&c.name==='FTBchCode').max_length=6;assert.throws(()=>source.validateSchema(s),/POINT_EXPORT_SCHEMA_TYPE_REFUSED/);
});
test('changed native formula, point numeric type or key ordering is refused before interpretation',()=>{
 const changedView=schemaFixture();changedView.viewDefinition+=' -- changed';assert.throws(()=>source.validateSchema(changedView),/POINT_EXPORT_VIEW_FINGERPRINT_REFUSED/);
 const changedType=schemaFixture();changedType.columns.find(c=>c.object_name==='TCNTCstPoint'&&c.name==='FNPntPoint').data_type='float';assert.throws(()=>source.validateSchema(changedType),/POINT_EXPORT_SCHEMA_TYPE_REFUSED/);
 const changedKey=schemaFixture();changedKey.pointPrimaryKey.reverse();assert.throws(()=>source.validateSchema(changedKey),/POINT_EXPORT_SCHEMA_KEY_REFUSED/);
});
test('owned receipt evidence participates in payload hashes and both bounded source stability passes',()=>{
 const s={identity:{machine:'POSSRV',db:'AdaAcc'},schemaHash:'a'.repeat(64),customers:[],points:[],balances:[],databaseIdentity:'005/POSSRV/AdaAcc',ownedCompensation:{present:true,meta:[],receipts:[{generation:'1'}]},sourceConsistency:{stable:true}};
 const before=source.sha(source.payloadContent(s));s.ownedCompensation.receipts[0].generation='2';assert.notEqual(source.sha(source.payloadContent(s)),before);
 const ps=fs.readFileSync(script,'utf8');assert.match(ps,/Snapshot-Hash[^\n]*\$owned/);assert.match(ps,/Snapshot-Hash[^\n]*\$againOwned/);assert.match(ps,/revision,generation,expected_intrinsic,previous_balance,target_balance,delta_points,created_at FROM dbo\.SCCRM_PointSyncReceipts/);assert.match(ps,/POINT_EXPORT_OWNED_PARTIAL_SCHEMA/);assert.doesNotMatch(ps,/SELECT\s+\*/i);
});
test('runtime module loading never imports the operator-only admin credential reader',()=>{
 const program="const M=require('node:module'),load=M._load;M._load=function(name,...args){if(String(name).includes('admin-source'))throw Error('OPERATOR_IMPORT_REFUSED');return load.call(this,name,...args)};require(process.argv[1]);process.stdout.write('runtime-loaded');";
 const result=spawnSync(process.execPath,['-e',program,path.join(source.ROOT,'export.cjs')],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,0);assert.equal(result.stdout,'runtime-loaded');assert.equal(result.stderr,'');
});
test('seven-fraction PowerShell capture timestamps are canonical UTC milliseconds before freshness persistence',()=>{
 const raw='2026-11-02T04:15:30.1234567Z',normalized=source.normalizeCaptureTimestamp(raw);assert.equal(normalized,'2026-11-02T04:15:30.123Z');
 const freshness=require('../points/delivery.cjs').normalizeFreshness({maxAgeMs:120000,sources:source.BRANCHES.map(branchCode=>({branchCode,databaseIdentity:branchCode+'/SERVER/AdaAcc',observedAt:normalized}))});
 assert.ok(freshness.sources.every(s=>s.observed_at===normalized));assert.equal(source.normalizeCaptureTimestamp('2026-11-02T04:15:30Z'),'2026-11-02T04:15:30.000Z');
 for(const invalid of['2026-11-02T04:15:30.1234567','2026-11-02T04:15:30.123+07:00','2026-02-30T04:15:30.1234567Z',null,123])assert.throws(()=>source.normalizeCaptureTimestamp(invalid),/POINT_EXPORT_CAPTURE_TIME_REFUSED/);
});
test('capture normalization never changes native business calendar dates or payload fingerprints',()=>{
 const snapshot={captureStartedAt:'2026-11-02T04:15:29.0000123Z',captureCompletedAt:'2026-11-02T04:15:30.1234567Z',identity:{machine:'SERVER',db:'AdaAcc'},schemaHash:'a'.repeat(64),customers:[{FDCstLastPoint:'2026-11-02T11:15:30.123'}],points:[{FDPntDate:'2026-11-02T11:15:30.123',FDDateIns:'2026-11-02T11:15:30.123'}],balances:[],sourceConsistency:{stable:true}};
 const normalized=source.normalizeCaptureTimes(snapshot);assert.equal(normalized.captureStartedAt,'2026-11-02T04:15:29.000Z');assert.equal(normalized.captureCompletedAt,'2026-11-02T04:15:30.123Z');assert.equal(snapshot.captureCompletedAt,'2026-11-02T04:15:30.1234567Z');assert.strictEqual(normalized.points,snapshot.points);assert.strictEqual(normalized.customers,snapshot.customers);assert.equal(normalized.points[0].FDPntDate,'2026-11-02T11:15:30.123');assert.equal(source.sha(source.payloadContent(normalized)),source.sha(source.payloadContent(snapshot)));
});
