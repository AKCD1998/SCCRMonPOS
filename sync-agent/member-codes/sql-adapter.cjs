'use strict';
const path=require('node:path'),readline=require('node:readline'),{spawn}=require('node:child_process');
const {normalizeProfile,profileHash}=require('../fanout/engine.cjs');
const {nativeValidity}=require('../fanout/sql-adapter.cjs');
const {validateAssignment,assignmentHash,validateDeliveryBinding,legacyScCodeFor}=require('./assignment.cjs');
class CodeRpc{
 constructor({mode,role,connection,timeoutMs=7000}){this.timeoutMs=timeoutMs;this.pending=new Map();this.next=0;this.closed=false;
  this.child=spawn('C:/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',path.join(__dirname,'SqlRpc.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PSModulePath:'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\Modules'}});
  this.child.stderr.on('data',()=>{});this.ready=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});this.ready.catch(()=>{});this.startTimer=setTimeout(()=>this.fail('RPC_TIMEOUT'),timeoutMs);
  readline.createInterface({input:this.child.stdout}).on('line',line=>{let r;try{r=JSON.parse(line.replace(/^\uFEFF/,''));}catch{return;}if(r.id===0){clearTimeout(this.startTimer);if(r.ok)this.resolve(r.rows);else this.fail(r.code||'CONNECTION_FAILED');return;}const p=this.pending.get(r.id);if(!p)return;this.pending.delete(r.id);clearTimeout(p.timer);p.cleanup?.();r.ok?p.resolve(r.rows):p.reject(Object.assign(Error(r.code),{code:r.code}));});
  this.child.on('error',()=>this.fail('RPC_PROCESS_ENDED'));this.child.on('exit',()=>this.fail('RPC_PROCESS_ENDED'));this.child.stdin.on('error',()=>this.fail('RPC_PROCESS_ENDED'));
  this.child.stdin.write(JSON.stringify({action:'init',scope:'SCCRM-HQ-MEMBER-CODES-V1',mode,role,connection})+'\n');
 }
 fail(code){if(this.closed)return;this.closed=true;clearTimeout(this.startTimer);const e=Object.assign(Error(code),{code});this.reject(e);for(const p of this.pending.values()){clearTimeout(p.timer);p.cleanup?.();p.reject(e);}this.pending.clear();this.child.stdin.destroy();this.child.kill();}
 async query(action,packet={},signal){await this.ready;if(this.closed)throw Object.assign(Error('CONNECTION_CLOSED'),{code:'CONNECTION_CLOSED'});if(signal?.aborted)throw Object.assign(Error('SERVICE_STOPPING'),{code:'SERVICE_STOPPING'});return new Promise((resolve,reject)=>{const id=++this.next,timer=setTimeout(()=>this.fail('RPC_TIMEOUT'),this.timeoutMs),cancel=()=>this.fail('DELIVERY_TIMEOUT');signal?.addEventListener('abort',cancel,{once:true});this.pending.set(id,{resolve,reject,timer,cleanup:()=>signal?.removeEventListener('abort',cancel)});this.child.stdin.write(JSON.stringify({id,action,...packet})+'\n');});}
 close(){this.fail('CONNECTION_CLOSED');}
}
class Connection{
 constructor(config,role){this.config=config;this.role=role;this.rpc=null;}
 async query(action,packet,signal){try{if(!this.rpc||this.rpc.closed)this.rpc=new CodeRpc({...this.config,role:this.role});return await this.rpc.query(action,packet,signal);}catch(e){if(this.rpc?.closed||/OFFLINE|TIMEOUT|CONNECTION|RPC_PROCESS/.test(e.code||'')){this.rpc?.close();this.rpc=null;}throw e;}}
 close(){this.rpc?.close();this.rpc=null;}
}
class AssignmentSource extends Connection{
 constructor(config){super(config,'source');}
 async read(checkpoint){const rows=await this.query('assignments',checkpoint?{afterAt:checkpoint.createdAt,afterAssignmentId:checkpoint.assignmentId}:{});return rows.map(r=>{
  const profile=normalizeProfile({name:r.profile_name,phone:r.profile_phone,email:r.profile_email||''});
  const assignment=validateAssignment({version:1,assignmentId:r.assignment_id,memberId:r.member_id,adaCode:r.ada_code,hqIdentity:r.hq_identity,profileHash:profileHash(profile),assignedAt:r.assigned_at,kind:r.assignment_kind},{expectedHqIdentity:this.config.connection.hqIdentity,allowApprovedExisting:true});
  return {assignment,profile,previousNativeCode:r.previous_code||null,assignmentHash:assignmentHash(assignment,{expectedHqIdentity:this.config.connection.hqIdentity,allowApprovedExisting:true})};});}
 async snapshot(assignmentId){const rows=await this.query('snapshot',{assignmentId});if(rows.length!==1)throw Error('CODE_NATIVE_SNAPSHOT_REQUIRED');return rows[0];}
}
class AssignmentAuthority extends Connection{
 constructor(config){super(config,'authority');}
 async approve(record,signal){return this.query('approve',record,signal);}
}
class AssignedReceiver extends Connection{
 constructor(config){super(config,'receiver');}
 async receive(job,{signal}={}){
  const a=job.assignment;const binding=validateDeliveryBinding(job,a,{expectedHqIdentity:this.config.connection.hqIdentity,allowApprovedExisting:true});
  const rows=await this.query('receive',{assignmentId:binding.assignmentId,memberId:job.member_id,code:job.hq_code,profile:job.profile,profileHash:job.profile_hash},signal);
  if(rows.length!==1)throw Error('CODE_NATIVE_ACK_REQUIRED');const r=rows[0],profile=normalizeProfile({name:r.profile_name,phone:r.profile_phone,email:r.profile_email||''});
  if(String(r.assignment_id).toLowerCase()!==binding.assignmentId||r.assignment_hash!==binding.assignmentHash||String(r.member_id).toLowerCase()!==job.member_id||r.hq_code!==job.hq_code||r.ada_code!==job.hq_code||r.target_identity!==job.database_identity||r.profile_hash!==job.profile_hash||profileHash(profile)!==job.profile_hash)throw Error('CODE_NATIVE_ACK_MISMATCH');
  const outcome=r.outcome==='existing'?'already_delivered':r.outcome==='migrated'?'existing_mapped':r.outcome;
  return {memberId:job.member_id,hqCode:job.hq_code,adaCode:r.ada_code,targetIdentity:r.target_identity,profile,profileHash:r.profile_hash,outcome,operationOutcome:r.outcome,receivedAt:r.received_at,assignmentId:binding.assignmentId,assignmentHash:binding.assignmentHash,...nativeValidity(r)};
 }
}
class CopyCreator extends Connection{constructor(config){if(config.mode!=='copy')throw Error('CODE_CREATOR_COPY_ONLY');super(config,'creator');}async create(memberId,profile){return this.query('create',{memberId,profile});}}
// Operator-only credentials are never included in the service's secret bundle.
class HqMigrationAuthority extends Connection{constructor(config){if(config.connection.branchCode!=='000')throw Error('CODE_MIGRATION_HQ_ONLY');super(config,'authority');}async migrate({memberId,previousCode,profile}){if(previousCode!==legacyScCodeFor(memberId))throw Error('CODE_MIGRATION_IDENTITY_REFUSED');return this.query('migrate',{memberId,previousCode,profile});}}
module.exports={CodeRpc,AssignmentSource,AssignmentAuthority,AssignedReceiver,CopyCreator,HqMigrationAuthority};
