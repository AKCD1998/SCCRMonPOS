'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
test('native target guard accepts verified named instances without widening host, owner or action scope', {skip:process.platform!=='win32'},()=>{
 const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',path.join(__dirname,'point-native-target-check.ps1')],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(r.status,0,r.stdout+r.stderr);
 const proof=JSON.parse(r.stdout.trim());
 assert.deepEqual(proof,{ok:true,checks:55,sqlConnections:0,productionWrites:0});
});
