'use strict';
// Bootstrap-only credential/provenance reader. Do not log the returned object or
// serialize it anywhere except the stdin pipe of the reviewed provisioner.
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {inspect} = require('node:util');
const BRANCHES = new Set(['000','001','003','004','005']);
function readAdmin(branch) {
  if(typeof branch!=='string'||!BRANCHES.has(branch))throw Error('ADMIN_SOURCE_BRANCH_REFUSED');
  const script=path.join(__dirname,'Read-AdminSource.ps1');
  const result=spawnSync('C:/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Branch',branch],
    {windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:65536,stdio:['ignore','pipe','pipe'],
      env:{...process.env,PSModulePath:'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\Modules'}});
  let packet;
  try{packet=JSON.parse(String(result.stdout||'').trim().replace(/^\uFEFF/,''));}
  catch{const error=Error('ADMIN_SOURCE_READER_UNAVAILABLE');error.code=error.message;error.branch=branch;throw error;}
  if(result.status!==0||!packet.ok){
    const code=/^[A-Z_]{6,100}$/.test(packet.code||'')?packet.code:'ADMIN_SOURCE_READ_FAILED';
    const error=Error(code);error.code=code;error.branch=branch;error.stage=packet.stage;
    error.sqlNumber=packet.sqlNumber;error.availableSqlKeys=packet.availableSqlKeys;error.errorType=packet.type;
    throw error;
  }
  if(packet.branch!==branch||packet.database!=='AdaAcc'||typeof packet.user!=='string'||!packet.user||
    typeof packet.password!=='string'||!packet.password||typeof packet.configuredServer!=='string'||
    !packet.provenance?.readonlySqlIdentityVerified||packet.provenance.remoteFilesWritten!==0){
    throw Error('ADMIN_SOURCE_RESPONSE_REFUSED');
  }
  delete packet.ok;
  Object.defineProperty(packet,inspect.custom,{enumerable:false,value(){return {branch:packet.branch,
    database:packet.database,configuredServer:packet.configuredServer,server:packet.server,
    machine:packet.machine,provenance:packet.provenance,credentials:'[redacted]'};}});
  return packet;
}
module.exports={readAdmin};
