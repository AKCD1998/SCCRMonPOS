'use strict';
const path=require('node:path'),{spawnSync}=require('node:child_process');
const {record,hash}=require('../history/model.cjs');
function verifiedRecords(packet,documents){
 if(!packet.ok||!['001','003','004','005'].includes(packet.branch)||packet.sourceId!=='branch'+packet.branch+'/AdaAcc'||packet.productionWrites!==0||packet.pinRead!==false)throw Error('BRANCH_RECEIPTS_ACK_REFUSED');
 if(![packet.first?.headers,packet.second?.headers,packet.first?.lines,packet.second?.lines].every(Array.isArray)||packet.first.headers.length>50||packet.second.headers.length>50||packet.first.lines.length>5000||packet.second.lines.length>5000)throw Error('BRANCH_RECEIPTS_ACK_REFUSED');
 const wanted=new Set(documents.map(d=>d.doc)),first=new Map(packet.first.headers.map(h=>[h.FTShdDocNo,h])),second=new Map(packet.second.headers.map(h=>[h.FTShdDocNo,h]));
 if(first.size!==packet.first.headers.length||second.size!==packet.second.headers.length||[...first.keys(),...second.keys()].some(doc=>!wanted.has(doc)))throw Error('BRANCH_RECEIPTS_DOCUMENT_REFUSED');
 const headers=[],lines=[],pending=[];
 for(const doc of wanted){
  const a=first.get(doc),b=second.get(doc),al=packet.first.lines.filter(l=>l.FTShdDocNo===doc),bl=packet.second.lines.filter(l=>l.FTShdDocNo===doc);
  if(!a||!b||!al.length||!bl.length||hash(a)!==hash(b)||hash(al)!==hash(bl)){pending.push(doc);continue;}
  if(a.FTBchCode!==packet.branch||a.FTShdStaDoc!=='1')throw Error('BRANCH_RECEIPTS_HEADER_REFUSED');
  headers.push(record('receipts',a));lines.push(...al.map(l=>record('lines',l,new Map([[doc,a]]))));
 }
 if(packet.first.lines.some(l=>!first.has(l.FTShdDocNo))||packet.second.lines.some(l=>!second.has(l.FTShdDocNo)))throw Error('BRANCH_RECEIPTS_LINE_SCOPE_REFUSED');
 return {sourceId:packet.sourceId,headers,lines,pending};
}
function readBranchReceipts(branch,documents){
 if(!['001','003','004','005'].includes(branch)||!Array.isArray(documents)||!documents.length||documents.length>50||documents.some(d=>!/^([SR])[0-9]{10}-[0-9]{7}$/.test(d.doc)||!['TPSTSalHD','TSHD001','TSHD002'].includes(d.table)))throw Error('BRANCH_RECEIPTS_SCOPE_REFUSED');
 let admin;
 try{
  admin=require('../fanout/admin-source.cjs').readAdmin(branch);
  const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'Read-BranchReceipts.ps1')],{windowsHide:true,encoding:'utf8',timeout:25000,maxBuffer:8388608,input:JSON.stringify({scope:'SCCRM-READ-BRANCH-RECEIPTS-V1',branch,documents,admin}),env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
  let p;try{p=JSON.parse(String(r.stdout||'').trim().replace(/^\uFEFF/,''));}catch{throw Error('BRANCH_RECEIPTS_READER_UNAVAILABLE');}
  if(r.status!==0||!p.ok)throw Error(/^BRANCH_RECEIPTS_[A-Z_]+$/.test(p.code||'')?p.code:'BRANCH_RECEIPTS_READ_FAILED');
  if(p.branch!==branch)throw Error('BRANCH_RECEIPTS_ACK_REFUSED');return verifiedRecords(p,documents);
 }finally{if(admin)admin.password='';}
}
module.exports={readBranchReceipts,verifiedRecords};
