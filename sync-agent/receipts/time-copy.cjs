'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {readAdmin}=require('../fanout/admin-source.cjs');
const ROOT=__dirname,RUNTIME=path.join(ROOT,'runtime/canonical-time'),MARKER='4afc7446-846e-4d6a-8a1b-e672655b1a38';fs.mkdirSync(RUNTIME,{recursive:true});
const peers={'000':['tcp:100.90.166.72,49800','SERVER'],'001':['100.81.137.41\\SQLEXPRESS','SC_001'],'003':['100.77.101.94\\SQLEXPRESS','POSSRV'],'004':['100.113.59.42\\SQLEXPRESS','SERVER004'],'005':['100.106.107.80\\SQLEXPRESS','POSSRV']};const admins={};
function databaseFor(b){if(!Object.hasOwn(peers,b))throw Error('RECEIPT_TIME_BRANCH_REFUSED');return 'SCCRM_ReceiptTimeCopy_20261111_'+b;}
function target(b,database='AdaAcc'){return {branch:b,server:peers[b][0],machine:peers[b][1],database};}
function sql(t,statements,parameters={},opts={}){const b=t.server==='tcp:100.90.166.72,49800'?'000':t.branch;if(!admins[b])admins[b]=readAdmin(b);const a=admins[b];const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,'TimeSql.ps1')],{windowsHide:true,encoding:'utf8',input:JSON.stringify({scope:'SCCRM-RECEIPT-TIME-OPERATOR-V1',target:t,credentials:{user:a.user,password:a.password},statements:Array.isArray(statements)?statements:[statements],parameters,...opts}),timeout:90000,maxBuffer:12000000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});let p;try{p=JSON.parse(r.stdout.trim().replace(/^\uFEFF/,''));}catch{throw Error('RECEIPT_TIME_SQL_OUTPUT_REFUSED');}if(!p.ok||r.status!==0){const e=Error(p.code);e.result=p;e.copySqlMessage=p.detail;throw e;}return p;}
function query(b,statement,parameters={},opts={}){return Promise.resolve(sql(target('000',databaseFor(b)),statement,parameters,{copy:true,...opts}));}
function create(b){
 const db=databaseFor(b),master=target('000','master');sql(master,`IF DB_ID('${db}') IS NULL EXEC('CREATE DATABASE [${db}] COLLATE Thai_CI_AS');`);
 const t=target('000',db),exists=sql(t,"SELECT OBJECT_ID('dbo.SCCRM_TimeCopyOwner') owned,OBJECT_ID('dbo.TCNMCst') customers").results[0][0];
 if(exists.owned){sql(t,`IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_TimeCopyOwner WHERE marker='${MARKER}') RAISERROR('RECEIPT_TIME_COPY_OWNER_REFUSED',16,1);`);return;}
 if(exists.customers)throw Error('RECEIPT_TIME_UNOWNED_COPY_REFUSED');
 const old='SCCRM_FanoutCopy_20261029_'+b;
 const tables=sql(target('000',old),"SELECT t.name,c.name column_name FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id WHERE t.name IN('TCNMCst','TPSTSalHD','TPSTSalDT','TSHD001','TSDT001','TSHD002','TSDT002') AND c.name NOT LIKE '%pin%' AND c.name NOT LIKE '%password%' AND c.name NOT LIKE '%secret%' AND c.name NOT LIKE '%token%' ORDER BY t.name,c.column_id").results[0];
 const statements=[];for(const name of [...new Set(tables.map(x=>x.name))]){const cols=tables.filter(x=>x.name===name).map(x=>{if(!/^[A-Za-z0-9_]+$/.test(x.column_name))throw Error('RECEIPT_TIME_COLUMN_REFUSED');return '['+x.column_name+']';}).join(',');statements.push(`SELECT ${cols} INTO dbo.[${name}] FROM [${old}].dbo.[${name}];`);}
 const pointColumns=sql(target('000'),"SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNTCstPoint') AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id").results[0].map(r=>{if(!/^[A-Za-z0-9_]+$/.test(r.name))throw Error('RECEIPT_TIME_COLUMN_REFUSED');return '['+r.name+']';});
 statements.push(`SELECT TOP(10) ${pointColumns.join(',')} INTO dbo.TCNTCstPoint FROM AdaAcc.dbo.TCNTCstPoint;CREATE TABLE dbo.SCCRM_TimeCopyOwner(marker uniqueidentifier PRIMARY KEY);INSERT dbo.SCCRM_TimeCopyOwner VALUES('${MARKER}');`);
 sql(t,statements);
}
module.exports={ROOT,RUNTIME,MARKER,databaseFor,target,sql,query,create};
if(require.main===module){try{for(const b of process.argv.slice(2))create(b);console.log(JSON.stringify({ok:true,branches:process.argv.slice(2),productionWrites:0,pinRead:false}));}catch(e){console.log(JSON.stringify({ok:false,code:e.message,proof:e.result}));process.exitCode=1;}}
