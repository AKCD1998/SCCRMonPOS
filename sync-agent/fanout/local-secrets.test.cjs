'use strict';
// Real Windows DPAPI round trip on synthetic data in a fresh private temp tree.
// Never opens the operator's real credential store or contacts a database.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('protected local JSON preserves Thai cohort names across UTF-8 stdin and DPAPI',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sccrm-utf8-test-'));fs.mkdirSync(path.join(root,'runtime'));
 const script=path.join(root,'LocalSecrets.ps1');fs.copyFileSync(path.join(__dirname,'LocalSecrets.ps1'),script);
 const fixture={version:1,cohort:[{name:'ทดสอบภาษาไทย ศิลารักษ์',memberId:'11111111-1111-4111-8111-111111111111'}],synthetic:'fixture-only'};
 const invoke=(action,input)=>spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',script,'-Action',action],{input,encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
 const write=invoke('Write',JSON.stringify(fixture));assert.equal(write.status,0);assert.equal(write.stdout.trim(),'PROTECTED');
 const read=invoke('Read');assert.equal(read.status,0);assert.deepEqual(JSON.parse(Buffer.from(read.stdout.trim(),'base64').toString('utf8')),fixture);
 // Only these known synthetic files are removed; no recursive/computed delete.
 fs.unlinkSync(path.join(root,'runtime','credentials.dpapi'));fs.unlinkSync(script);fs.rmdirSync(path.join(root,'runtime'));fs.rmdirSync(root);
});
