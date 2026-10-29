'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {profileHash,normalizeProfile}=require('./engine.cjs');
function nativeValidity(row){
 const fail=()=>{throw Object.assign(Error('ACK_NATIVE_VALIDITY_MISMATCH'),{code:'ACK_NATIVE_VALIDITY_MISMATCH'});};
 const parse=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return fail();const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)return fail();return d;};
 const issue=parse(row.card_issue_date),expiry=parse(row.card_expiry_date),year=issue.getUTCFullYear()+100,month=issue.getUTCMonth();
 if(year>9999||row.native_lookup_eligible!==1)return fail();
 const expected=new Date(Date.UTC(year,month,Math.min(issue.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate())));
 if(expiry.getTime()!==expected.getTime())return fail();
 return {cardIssueDate:row.card_issue_date,cardExpiryDate:row.card_expiry_date,nativeLookupEligible:true};
}
class SqlRpc {
 constructor({mode,role,connection,timeoutMs=7000}){
  this.sequence=0;this.pending=new Map();this.timeoutMs=timeoutMs;this.closed=false;
  const env={...process.env,PSModulePath:'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\Modules'};
  this.child=spawn('C:/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',path.join(__dirname,'SqlRpc.ps1')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.child.stderr.on('data',()=>{});
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});this.ready.catch(()=>{});
  this.initTimer=setTimeout(()=>this.fail('RPC_TIMEOUT'),timeoutMs);
  readline.createInterface({input:this.child.stdout}).on('line',line=>{
   let reply;try{reply=JSON.parse(line.replace(/^\uFEFF/,''));}catch{return;}
   if(reply.id===0){clearTimeout(this.initTimer);if(reply.ok)this.resolveReady(reply.rows);else this.fail(reply.code||'CONNECTION_FAILED');return;}
   const job=this.pending.get(reply.id);if(!job)return;this.pending.delete(reply.id);clearTimeout(job.timer);job.cleanup?.();
   if(reply.ok)job.resolve(reply.rows);else job.reject(Object.assign(Error(reply.code),{code:reply.code}));
  });
  this.child.on('error',()=>this.fail('RPC_PROCESS_ENDED'));
  this.child.on('exit',()=>this.fail('RPC_PROCESS_ENDED'));
  this.child.stdin.on('error',()=>this.fail('RPC_PROCESS_ENDED'));
  this.child.stdin.write(JSON.stringify({action:'init',scope:'SCCRM-HQ-BRANCH-FANOUT-V1',mode,role,connection})+'\n');
 }
 fail(code){if(this.closed)return;this.closed=true;clearTimeout(this.initTimer);const error=Object.assign(Error(code),{code});this.rejectReady(error);for(const p of this.pending.values()){clearTimeout(p.timer);p.cleanup?.();p.reject(error);}this.pending.clear();this.child.stdin.destroy();this.child.kill();}
 async query(action,packet={},signal){await this.ready;if(this.closed)throw Object.assign(Error('CONNECTION_CLOSED'),{code:'CONNECTION_CLOSED'});if(signal?.aborted)throw Object.assign(Error('SERVICE_STOPPING'),{code:'SERVICE_STOPPING'});
  return new Promise((resolve,reject)=>{const id=++this.sequence;const timer=setTimeout(()=>this.fail('RPC_TIMEOUT'),this.timeoutMs);const cancel=()=>this.fail('DELIVERY_TIMEOUT');signal?.addEventListener('abort',cancel,{once:true});this.pending.set(id,{resolve,reject,timer,cleanup:()=>signal?.removeEventListener('abort',cancel)});this.child.stdin.write(JSON.stringify({id,action,...packet})+'\n');});
 }
 close(){this.fail('CONNECTION_CLOSED');}
}
class HqSource {
 constructor(config){this.config=config;this.rpc=null;}
 async read(checkpoint){try{if(!this.rpc||this.rpc.closed)this.rpc=new SqlRpc({...this.config,role:'source'});const rows=await this.rpc.query('confirmed',checkpoint?{afterCreatedAt:checkpoint.createdAt,afterMemberId:checkpoint.memberId}:{});
  return rows.map(r=>({memberId:r.member_id.toLowerCase(),hqCode:r.ada_code,profile:{name:r.profile_name,phone:r.profile_phone,email:r.profile_email||''},hqConfirmedAt:r.hq_confirmed_at}));
 }catch(e){this.rpc?.close();this.rpc=null;throw e;}}
 close(){this.rpc?.close();this.rpc=null;}
}
class NativeReceiver {
 constructor(config){this.config=config;this.rpc=null;}
 async receive(job,{signal}={}){try{
  if(!this.rpc||this.rpc.closed)this.rpc=new SqlRpc({...this.config,role:'receiver'});
  const rows=await this.rpc.query('receive',{memberId:job.member_id,hqCode:job.hq_code,profile:job.profile,profileHash:job.profile_hash},signal);
  if(rows.length!==1)throw Object.assign(Error('ACK_REQUIRED'),{code:'ACK_REQUIRED'});
  const r=rows[0],profile=normalizeProfile({name:r.profile_name,phone:r.profile_phone,email:r.profile_email||''});
  // SQL 2008 cannot calculate SHA256. Hash its actual returned native fields,
  // rather than trusting the opaque digest that the sender supplied earlier.
  if(profileHash(profile)!==r.profile_hash)throw Object.assign(Error('ACK_PROFILE_MISMATCH'),{code:'ACK_PROFILE_MISMATCH'});
  const validity=nativeValidity(r);
  return {memberId:r.member_id,hqCode:r.hq_code,adaCode:r.ada_code,targetIdentity:r.target_identity,profile,profileHash:r.profile_hash,outcome:r.outcome==='existing'?'already_delivered':r.outcome,receivedAt:r.received_at,...validity};
 }catch(e){if(this.rpc?.closed||/OFFLINE|TIMEOUT|CONNECTION|RPC_PROCESS/.test(e.code||'')){this.rpc?.close();this.rpc=null;}throw e;}}
 async identity(){if(!this.rpc||this.rpc.closed)this.rpc=new SqlRpc({...this.config,role:'receiver'});return this.rpc.query('identity');}
 close(){this.rpc?.close();this.rpc=null;}
}
module.exports={SqlRpc,HqSource,NativeReceiver,nativeValidity};
