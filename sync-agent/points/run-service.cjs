'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Pool}=require('pg');
const {machineSecrets}=require('./secrets.cjs');
const {createWorker}=require('./worker.cjs');
const {invokeNative,createTarget}=require('./native-adapter.cjs');
const SCOPE='SCCRM-ADA-PRIMARY-POINTS-SERVICE-V1',ROOT=__dirname;
function safe(e){return /^[A-Z][A-Z_0-9]{4,100}$/.test(e?.code||e?.message||'')?(e.code||e.message):'POINT_SERVICE_FAILED';}
function publish(value){const target=path.join(ROOT,'status','service.json'),temp=target+'.tmp';fs.writeFileSync(temp,JSON.stringify({...value,at:new Date().toISOString()}));fs.renameSync(temp,target);}
async function main(){
 if(process.env.COMPUTERNAME!=='SERVER'||path.resolve(ROOT).toLowerCase()!=='d:\\sccrm-hq-livesync-20261024\\points')throw Error('POINT_HQ_SERVICE_LOCATION_REQUIRED');
 machineSecrets('Init');
 if(!fs.existsSync(path.join(ROOT,'runtime','credentials.hybrid.json'))){publish({state:'awaiting_credentials',scope:SCOPE});return;}
 const config=JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'))),secrets=machineSecrets();
 if(config.scope!==SCOPE||config.mode!=='Live'||secrets.scope!==SCOPE)throw Error('POINT_SERVICE_SCOPE_REFUSED');
 const pg=new URL(secrets.pgUrl);
 if(!pg.hostname.endsWith('.pooler.supabase.com')||pg.port!=='5432'||pg.pathname!=='/postgres'||decodeURIComponent(pg.username)!=='sccrm_ada_points.fneevjmjlgvjqcocknft')throw Error('POINT_SERVICE_PRIVATE_PG_ROLE_REQUIRED');
 const nativeTargets=config.sources.map(s=>{
  const credentials=secrets.sourceCredentials?.[s.branchCode];if(credentials?.user!=='sccrm_point_sync_'+s.branchCode||!credentials.password)throw Error('POINT_SERVICE_PRIVATE_NATIVE_ROLE_REQUIRED');
  return {source:s,target:{branch:s.branchCode,server:s.server,machine:s.machine,database:'AdaAcc',identity:s.databaseIdentity},credentials};
 });
 // Refuse an accidental broad/admin credential before reading or delivering.
 for(const t of nativeTargets)await invokeNative({mode:'Live',target:t.target,credentials:t.credentials,action:'rights'});
 const pool=new Pool({connectionString:secrets.pgUrl,ssl:{ca:fs.readFileSync(path.join(ROOT,'supabase-ca.crt'),'utf8'),rejectUnauthorized:true},max:7,connectionTimeoutMillis:8000,query_timeout:45000,application_name:'SCCRM-HQ-AdaPrimary-Points'});
 let worker;
 try{
  const rights=(await pool.query("SELECT current_user,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  if(!rights||rights.current_user!=='sccrm_ada_points'||rights.rolsuper||rights.rolcreaterole||rights.rolcreatedb||rights.rolbypassrls)throw Error('POINT_SERVICE_PG_RIGHTS_EXCESSIVE');
  const restricted=(await pool.query("SELECT NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user) no_membership,has_schema_privilege(current_user,'ada_points','CREATE') points_ddl,has_table_privilege(current_user,'public.point_ledger','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') ledger_access,has_table_privilege(current_user,'public.member_profiles','SELECT,INSERT,UPDATE,DELETE') profile_access,has_table_privilege(current_user,'ada_history.member_links','SELECT,INSERT,UPDATE,DELETE') link_access")).rows[0];
  if(!restricted.no_membership||restricted.points_ddl||restricted.ledger_access||restricted.profile_access||restricted.link_access)throw Error('POINT_SERVICE_PG_RIGHTS_EXCESSIVE');
  const targets=config.targets.map(t=>{const n=nativeTargets.find(n=>n.source.branchCode===t.branchCode);return createTarget({mode:'Live',target:n.target,credentials:n.credentials,targetId:t.targetId});});
  const adminReader=branch=>{const n=nativeTargets.find(n=>n.source.branchCode===branch);if(!n)throw Error('POINT_SERVICE_SOURCE_NOT_CONFIGURED');return {branch,database:'AdaAcc',machine:n.source.machine,server:n.source.server,user:n.credentials.user,password:n.credentials.password,configuredServer:n.source.configuredServer,provenance:{...n.source.provenance,effectiveConfigRead:true,readonlySqlIdentityVerified:true,remoteFilesWritten:0,pinRead:false}};};
  worker=createWorker({db:pool,config,adminReader,targets,onStatus:s=>publish({scope:SCOPE,...s})});
  process.on('SIGTERM',()=>worker.requestStop());process.on('SIGINT',()=>worker.requestStop());
  await worker.start();
 }finally{await pool.end();}
}
if(require.main===module)main().catch(e=>{try{publish({scope:SCOPE,state:'blocked',code:safe(e)});}catch{};process.exitCode=1;});
module.exports={SCOPE,main};
