'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process');
const {readAdmin}=require('../fanout/admin-source.cjs');
const {privateRuntime,safeCode}=require('./export.cjs');
const ROOT=__dirname,RUNTIME=path.join(ROOT,'runtime');
// Fixed ports were verified from the effective Ada configs/SQL listeners; these
// are server identities, not the POS terminal Tailscale addresses.
const TCP=Object.freeze({'000':'tcp:100.90.166.72,49800','001':'tcp:100.81.137.41,49754','003':'tcp:100.77.101.94,49703','004':'tcp:100.113.59.42,49976','005':'tcp:100.106.107.80,49711'});
const fail=c=>{throw Object.assign(Error(c),{code:c});};
function invoke(file,packet,timeout=120000,args=[]){
 const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,file),...args],{input:JSON.stringify(packet),encoding:'utf8',windowsHide:true,timeout,maxBuffer:96*1024*1024,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
 let d;try{d=JSON.parse((r.stdout||'').trim().replace(/^\uFEFF/,''));}catch{fail('POINT_NATIVE_SAFE_RESULT_REQUIRED');}
 if(r.status!==0||!d.ok)throw Object.assign(Error(d.code||'POINT_NATIVE_OPERATION_FAILED'),{code:d.code||'POINT_NATIVE_OPERATION_FAILED',stage:d.stage,sqlNumber:d.sqlNumber});
 return d;
}
function provisionCopies(branches){
 if(!Array.isArray(branches)||!branches.length||branches.some(b=>!['000','001','003','004','005'].includes(b)))fail('POINT_NATIVE_EXPLICIT_BRANCHES_REQUIRED');
 privateRuntime();
 const stateFile=path.join(RUNTIME,'native-copy.secrets.json');
 const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{scope:'SCCRM-ADA-POINT-COPY-PROVISION-20261102',copies:{}};
 const results=[];
 for(const branch of branches){
  if(state.copies[branch]?.provisioned)fail('POINT_COPY_ALREADY_PROVISIONED');
  const s=JSON.parse(fs.readFileSync(path.join(RUNTIME,'native-live-'+branch+'.json')));
  const admin=readAdmin('000'),copyPassword=state.copies[branch]?.password||'Sc!'+crypto.randomBytes(28).toString('hex');
  state.copies[branch]={password:copyPassword,provisioned:false};fs.writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});
  try{const r=invoke('Provision-PointCopy.ps1',{scope:state.scope,branch,snapshot:s,admin:{user:admin.user,password:admin.password},copyPassword});
   state.copies[branch].provisioned=true;state.copies[branch].database=r.database;state.copies[branch].identity=r.identity;
   fs.writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});results.push(r);
  }finally{admin.password='';}
 }
 const r={ok:true,scope:state.scope,results,productionWrites:0,pinRead:false};fs.writeFileSync(path.join(RUNTIME,'native-copy-provision-result.json'),JSON.stringify(r,null,2));return r;
}
function preflight(branches){
 if(!Array.isArray(branches)||!branches.length||branches.some(b=>!['000','001','003','004','005'].includes(b)))fail('POINT_NATIVE_EXPLICIT_BRANCHES_REQUIRED');
 privateRuntime();const results=[];
 for(const branch of branches){const a=readAdmin(branch);try{results.push(invoke('Provision-LivePoints.ps1',{scope:'SCCRM-ADA-PRIMARY-POINTS-LIVE-PROVISION-V1',target:{branch,server:TCP[branch],machine:a.machine,database:a.database,identity:branch+'/'+a.machine+'/'+a.database},admin:{user:a.user,password:a.password}},30000,['-Action','Preflight']));}catch(e){results.push({ok:false,branch,code:safeCode(e),stage:e.stage,sqlNumber:e.sqlNumber});}finally{a.password='';}}
 const r={ok:results.every(x=>x.ok),at:new Date().toISOString(),action:'read-only-preflight',results,productionWrites:0,pinRead:false};fs.writeFileSync(path.join(RUNTIME,'live-preflight-result.json'),JSON.stringify(r,null,2));return r;
}
if(require.main===module){try{const action=process.argv[2];if(!['provision-copy','preflight-live'].includes(action))fail('POINT_NATIVE_EXPLICIT_ACTION_REQUIRED');console.log(JSON.stringify(action==='provision-copy'?provisionCopies(process.argv.slice(3)):preflight(process.argv.slice(3))));}catch(e){console.error(JSON.stringify({ok:false,code:safeCode(e),stage:e.stage,sqlNumber:e.sqlNumber,productionWrites:0}));process.exitCode=1;}}
module.exports={ROOT,RUNTIME,TCP,invoke,provisionCopies,preflight};
