'use strict';
// Explicit operator invocation only. Not deployed to or imported by the service.
const path=require('node:path');
const {spawnSync}=require('node:child_process');
function repairOwnedValidity({mode,target,admin,members,pilotApproved=false}){
 if(!['Copy','Live'].includes(mode)||!Array.isArray(members)||members.length<1||members.length>2)throw Error('VALIDITY_SCOPE_REFUSED');
 const input={scope:'SCCRM-OWNED-VALIDITY-REPAIR-V1',marker:'86bfa892-2f57-4f60-a3f8-10b90ab5c7a9',policy:'calendar-years-100',target,admin,members,pilotApproved};
 const result=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'Repair-OwnedValidity.ps1'),'-Mode',mode],{input:JSON.stringify(input),windowsHide:true,encoding:'utf8',timeout:45000,maxBuffer:65536,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
 let report;try{report=JSON.parse(result.stdout.replace(/^\uFEFF/,'').trim());}catch{throw Error('VALIDITY_NO_SAFE_RESULT');}
 if(result.status!==0||!report.ok)throw Object.assign(Error(report.code||'VALIDITY_REPAIR_REFUSED'),{code:report.code||'VALIDITY_REPAIR_REFUSED',report});return report;
}
module.exports={repairOwnedValidity};
