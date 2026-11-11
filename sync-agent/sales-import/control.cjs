'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {readAdmin}=require('../fanout/admin-source.cjs');
const meta=require('./schema.cjs');
const ROOT=__dirname,run=path.join(ROOT,'runtime'),build=path.resolve(ROOT,'../../build-verify/sales-import');
fs.mkdirSync(run,{recursive:true});fs.mkdirSync(build,{recursive:true});
const peers={'000':['tcp:100.90.166.72,49800','SERVER'],'001':['100.81.137.41\\SQLEXPRESS','SC_001'],'003':['100.77.101.94\\SQLEXPRESS','POSSRV'],'004':['100.113.59.42\\SQLEXPRESS','SERVER004'],'005':['100.106.107.80\\SQLEXPRESS','POSSRV']};
const branches=['001','003','004','005'];
const s=meta.schema(JSON.parse(fs.readFileSync(path.join(run,'probe-000.json'),'utf8')));
function ps(file,input,args=[]){const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,file),...args],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:12000000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});let p;try{p=JSON.parse(r.stdout.trim().replace(/^\uFEFF/,''));}catch{throw Error('SALES_CONTROL_OUTPUT_FAILED');}if(r.status!==0||!p.ok){const e=Error(p.code||'SALES_CONTROL_FAILED');e.proof=p;throw e;}return p;}
const admins={};function admin(branch,database='AdaAcc'){if(!admins[branch])admins[branch]=readAdmin(branch);return {...admins[branch],server:peers[branch][0],machine:peers[branch][1],database};}
function sql(target,statements){return ps('Sql.ps1',{scope:meta.SCOPE,target,statements:Array.isArray(statements)?statements:[statements]}).sets;}
function save(value){ps('LocalSecrets.ps1',{value});}
function secrets(){return ps('LocalSecrets.ps1',{}).value;}
function compile(){const exe=path.join(build,'SCCRMHQSalesImport.exe');const r=spawnSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:exe','/r:System.ServiceProcess.dll','/r:System.Data.dll','/r:System.Security.dll','/r:System.Web.Extensions.dll','/out:'+exe,path.join(ROOT,'SalesImport.cs')],{encoding:'utf8',windowsHide:true,timeout:30000});if(r.status!==0){console.error(r.stdout);throw Error('SALES_COMPILE_FAILED');}return exe;}
function call(config,action,branch='',args={}){const r=spawnSync(path.join(build,'SCCRMHQSalesImport.exe'),['--call'],{input:JSON.stringify({config,action,branch,...args}),encoding:'utf8',windowsHide:true,timeout:65000,maxBuffer:6000000});let p;try{p=JSON.parse(r.stdout.trim());}catch{throw Error('SALES_CALL_OUTPUT_FAILED');}if(!p.ok){const e=Error(p.code);e.result=p;throw e;}return p.result;}
const keys={TPSTSalHD:['FTShdDocNo'],TPSTSalDT:['FTShdDocNo','FNSdtSeqNo'],TPSTSalRC:['FTShdDocNo','FNSrcSeqNo'],TPSTSalPD:['FTShdDocNo','FTPmhCode','FTSpdGrpName','FTSpdBarCode','FNSdtSeqNo'],TPSTSalPG:['FTShdDocNo','FTPmhCode','FTSpgGrpName'],TPSTSalPH:['FTShdDocNo','FTPmhCode'],TPSTSalInvCsm:['FTShdDocNo','FNSicSeqNo','FTPdtCode'],TPSTVoidDT:['FTVidSeq','FNSdtSeqNo']};
function copyDb(branch){return 'SCCRM_SalesLab_20261111_'+branch;}
function literal(v){return "N'"+String(v).replaceAll("'","''")+"'";}
function createCopy(branch){
 const database=copyDb(branch),master=admin('000','master');
 sql(master,`IF DB_ID('${database}') IS NULL EXEC('CREATE DATABASE [${database}] COLLATE Thai_CI_AS');`);
 const target=admin('000',database),exists=sql(target,"SELECT OBJECT_ID('dbo.SCCRM_SalesMeta') id,OBJECT_ID('dbo.TPSTSalHD') native")[0][0];
 if(exists.id){const own=sql(target,"SELECT marker,schema_hash FROM dbo.SCCRM_SalesMeta")[0][0];if(String(own.marker).toLowerCase()!==meta.MARKER||own.schema_hash!==s.hash)throw Error('SALES_COPY_OWNERSHIP_REFUSED');return;}
 if(exists.native)throw Error('SALES_COPY_UNOWNED_NATIVE_REFUSED');
 const ddl=meta.TABLES.map(t=>meta.nativeTableDdl(s,t)+` CREATE UNIQUE INDEX [SCCRM_SalesLab_PK] ON dbo.[${t}](${keys[t].map(c=>'['+c+']').join(',')});`).join('\n');
 sql(target,[ddl+"CREATE TABLE dbo.TCNMCst(FTCstCode varchar(20) PRIMARY KEY);CREATE TABLE dbo.TCNTCstPoint(id int PRIMARY KEY,FTCstCode varchar(20),points float);INSERT dbo.TCNTCstPoint VALUES(1,'COPY_ONLY',777);",`CREATE TABLE dbo.SCCRM_SalesMeta(singleton int PRIMARY KEY,marker uniqueidentifier,schema_hash char(64),scope varchar(80));INSERT dbo.SCCRM_SalesMeta VALUES(1,'${meta.MARKER}','${s.hash}','${meta.SCOPE}');`]);
}
function provisionQueue(target){
 const existing=sql(target,"SELECT OBJECT_ID('dbo.SCCRM_SalesJobs') id,OBJECT_ID('dbo.SCCRM_SalesMeta') meta")[0][0];
 if(existing.id){const own=sql(target,"SELECT marker,schema_hash FROM dbo.SCCRM_SalesMeta")[0][0];if(String(own.marker).toLowerCase()!==meta.MARKER||own.schema_hash!==s.hash)throw Error('SALES_QUEUE_OWNERSHIP_REFUSED');if(target.database==='AdaAcc')throw Error('SALES_LIVE_UPGRADE_REVIEW_REQUIRED');
  const queue=fs.readFileSync(path.join(ROOT,'queue.sql'),'utf8').replaceAll('__DATABASE__',target.database).replaceAll('__MARKER__',meta.MARKER).replaceAll('__SCHEMA__',s.hash).split('-- BATCH')[1].trim().replace('CREATE PROCEDURE','ALTER PROCEDURE');sql(target,["IF COL_LENGTH('dbo.SCCRM_SalesSources','last_scan_at') IS NULL ALTER TABLE dbo.SCCRM_SalesSources ADD last_scan_at datetime;",queue,meta.receiver(s,target.database).replace('CREATE PROCEDURE','ALTER PROCEDURE')]);return;}
 let queue=fs.readFileSync(path.join(ROOT,'queue.sql'),'utf8').replaceAll('__DATABASE__',target.database).replaceAll('__MARKER__',meta.MARKER).replaceAll('__SCHEMA__',s.hash);
 if(existing.meta)queue=queue.replace(/CREATE TABLE dbo.SCCRM_SalesMeta[^\n]*\r?\n/,'');
 const batches=queue.split('-- BATCH').map(x=>x.trim());if(!existing.meta)batches[0]+=`\nINSERT dbo.SCCRM_SalesMeta VALUES(1,'${meta.MARKER}','${s.hash}','${meta.SCOPE}');`;
 sql(target,[...batches,meta.receiver(s,target.database)]);
}
function restricted(target,branch,hq,live,credentials){
 const name='sccrm_sales_'+(hq?'hq':'export_'+branch)+(live?'':'_copy');
 let login=credentials[name];if(!login){login={user:name,password:crypto.randomBytes(36).toString('base64')+'9a!'};credentials[name]=login;save(credentials);}
 const a=admin(live?branch:'000','master');sql(a,`IF SUSER_ID('${name}') IS NULL CREATE LOGIN [${name}] WITH PASSWORD=${literal(login.password)},CHECK_POLICY=ON;`);
 const grants=hq?['GRANT EXECUTE ON dbo.SCCRM_SalesQueue TO ['+name+'];','GRANT EXECUTE ON dbo.SCCRM_SalesApply TO ['+name+'];']:meta.TABLES.map(t=>`GRANT SELECT ON dbo.[SCCRM_SalesExport_${t}] TO [${name}];`);
 sql(target,[`IF USER_ID('${name}') IS NULL CREATE USER [${name}] FOR LOGIN [${name}];`,...grants]);
 return {server:target.server,machine:target.machine,database:target.database,...login};
}
function provision(mode){
 const live=mode==='Live',credentials=fs.existsSync(path.join(run,'credentials.dpapi'))?secrets():{};
 if(!live)for(const branch of ['000',...branches])createCopy(branch);
 const hq=admin('000',live?'AdaAcc':copyDb('000'));provisionQueue(hq);
 const cfg={scope:meta.SCOPE,schema:s.hash,hq:restricted(hq,'000',true,live,credentials),sources:{}};
 for(const branch of branches){const target=live?admin(branch):admin('000',copyDb(branch));
  if(!live)sql(target,Object.entries(meta.ACTIVE).flatMap(([native,stem])=>['001','002'].map(pos=>`IF OBJECT_ID('dbo.[${stem+pos}]') IS NULL BEGIN ${meta.nativeTableDdl(s,native).replace('dbo.['+native+']','dbo.['+stem+pos+']')} END;`)).join('\n'));
  const activeColumns=sql(target,"SELECT t.name table_name,c.name column_name,ty.name type_name,c.max_length,c.precision FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE t.name IN("+Object.values(meta.ACTIVE).flatMap(stem=>['001','002'].map(pos=>"'"+stem+pos+"'")).join(',')+") ORDER BY t.name,c.column_id")[0];
  for(const [native,stem]of Object.entries(meta.ACTIVE))for(const pos of ['001','002']){const expected=s.columns.filter(x=>x.table_name===native),columns=activeColumns.filter(x=>x.table_name===stem+pos);if(expected.length!==columns.length||expected.some((x,i)=>['column_name','type_name','max_length','precision'].some(k=>x[k]!==columns[i][k])))throw Error('SALES_ACTIVE_SCHEMA_DIFFERENT');}
  const existingViews=new Map(sql(target,"SELECT name,OBJECT_DEFINITION(object_id) definition FROM sys.views WHERE name LIKE 'SCCRM_Sales%'")[0].map(x=>[x.name,x.definition]));
  for(const statement of meta.sourceViews(s,branch)){const name=statement.match(/CREATE VIEW dbo\.\[([^\]]+)\]/)[1];if(!existingViews.has(name))sql(target,statement);else if(existingViews.get(name).trim()!==statement.trim()){if(live)throw Error('SALES_EXPORT_VIEW_CHANGED');sql(target,statement.replace('CREATE VIEW','ALTER VIEW'));}}
  cfg.sources[branch]=restricted(target,branch,false,live,credentials);
 }
 credentials[live?'liveConfig':'copyConfig']=cfg;save(credentials);return {ok:true,mode,schema:s.hash,branches,productionDataWrites:0};
}
function seal(value,jwk){const key=crypto.randomBytes(64),iv=crypto.randomBytes(16),plain=Buffer.from(JSON.stringify(value));try{const aes=crypto.createCipheriv('aes-256-cbc',key.subarray(0,32),iv),cipher=Buffer.concat([aes.update(plain),aes.final()]),mac=crypto.createHmac('sha256',key.subarray(32)).update(Buffer.from('SCCRM-SALES-SECRETS-V1\0')).update(iv).update(cipher).digest();return {version:1,encryptedKey:crypto.publicEncrypt({key:crypto.createPublicKey({key:jwk,format:'jwk'}),oaepHash:'sha1'},key).toString('base64'),iv:iv.toString('base64'),ciphertext:cipher.toString('base64'),mac:mac.toString('base64')};}finally{key.fill(0);plain.fill(0);}}
module.exports={ROOT,run,build,s,ps,sql,admin,secrets,save,compile,call,copyDb,literal,keys,provision,seal,meta,branches};
if(require.main===module){try{const action=process.argv[2];let result;if(action==='compile')result={ok:true,exe:compile()};else if(action==='copy')result=provision('Copy');else if(action==='live'){const proof=JSON.parse(fs.readFileSync(path.join(run,'copy-proof.json')));if(!proof.ok||proof.sourceHash!==sourceHash())throw Error('SALES_COPY_PROOF_REQUIRED');result=provision('Live');}else throw Error('SALES_ACTION_REFUSED');console.log(JSON.stringify(result));}catch(e){console.log(JSON.stringify({ok:false,code:e.message,proof:e.proof}));process.exitCode=1;}}
function sourceHash(){const h=crypto.createHash('sha256');for(const file of ['SalesImport.cs','schema.cjs','queue.sql'])h.update(fs.readFileSync(path.join(ROOT,file)));return h.digest('hex');}module.exports.sourceHash=sourceHash;
