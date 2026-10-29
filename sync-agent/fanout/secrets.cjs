'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
function powershell(file,args=[],input){const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',path.join(__dirname,file),...args],{input,windowsHide:true,encoding:'utf8',timeout:45000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});if(r.status!==0)throw Error('FANOUT_SECRET_OPERATION_REFUSED');return r.stdout.trim();}
function localSecrets(){return JSON.parse(Buffer.from(powershell('LocalSecrets.ps1',['-Action','Read']),'base64').toString('utf8'));}
function saveLocalSecrets(value){powershell('LocalSecrets.ps1',['-Action','Write'],JSON.stringify(value));}
function machineSecrets(action='Read'){const raw=powershell('SecretBridge.ps1',['-Action',action]);return action==='Init'?null:JSON.parse(Buffer.from(raw,'base64').toString('utf8'));}
function seal(secrets,jwk){
 const key=crypto.randomBytes(64),iv=crypto.randomBytes(16);let plain;
 try{plain=Buffer.from(JSON.stringify(secrets));const aes=crypto.createCipheriv('aes-256-cbc',key.subarray(0,32),iv);const ciphertext=Buffer.concat([aes.update(plain),aes.final()]);const mac=crypto.createHmac('sha256',key.subarray(32)).update(Buffer.from('SCCRM-FANOUT-SECRETS-V1\0')).update(iv).update(ciphertext).digest();const encryptedKey=crypto.publicEncrypt({key:crypto.createPublicKey({key:jwk,format:'jwk'}),oaepHash:'sha1',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key);
  return {version:1,encryptedKey:encryptedKey.toString('base64'),iv:iv.toString('base64'),ciphertext:ciphertext.toString('base64'),mac:mac.toString('base64')};
 }finally{key.fill(0);plain?.fill(0);}
}
module.exports={powershell,localSecrets,saveLocalSecrets,machineSecrets,seal};
