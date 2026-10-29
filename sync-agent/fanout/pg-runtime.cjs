'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {MARKER}=require('./engine.cjs');
const ROLE='sccrm_hq_member_fanout';
const TABLES=['meta','targets','sources','source_checkpoint','jobs','mappings','events'];
function identifier(s){if(typeof s!=='string'||!/^sccrm_[a-z0-9_]{1,54}$/.test(s))throw Error('FANOUT_ROLE_REFUSED');return '"'+s+'"';}
async function provisionQueue(admin,{role=ROLE,password}){
 const name=identifier(role);if(!/^[a-f0-9]{48,96}$/.test(password))throw Error('FANOUT_PASSWORD_FORMAT_REFUSED');
 await admin.query('BEGIN');try{
  await admin.query("SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='15s'");
  const description='SCCRM dedicated member fanout '+MARKER;
  const previous=(await admin.query("SELECT shobj_description(oid,'pg_authid') description FROM pg_roles WHERE rolname=$1",[role])).rows[0];
  if(previous&&previous.description!==description)throw Error('FANOUT_ROLE_COLLISION');
  if(!previous){await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 8 PASSWORD '${password}'`);await admin.query(`COMMENT ON ROLE ${name} IS '${description}'`);}
  await admin.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
  await admin.query(`GRANT USAGE ON SCHEMA sccrm_fanout TO ${name};GRANT SELECT ON ALL TABLES IN SCHEMA sccrm_fanout TO ${name};GRANT USAGE ON ALL SEQUENCES IN SCHEMA sccrm_fanout TO ${name};GRANT INSERT ON sccrm_fanout.sources,sccrm_fanout.jobs,sccrm_fanout.mappings,sccrm_fanout.events TO ${name}`);
  await admin.query(`GRANT UPDATE(state,last_code,observed_conflict_hash) ON sccrm_fanout.sources TO ${name};GRANT UPDATE(created_at,member_id,updated_at) ON sccrm_fanout.source_checkpoint TO ${name};GRANT UPDATE(lease_token,lease_owner,lease_until) ON sccrm_fanout.targets TO ${name};GRANT UPDATE(state,attempt_count,next_attempt_at,lease_token,lease_owner,lease_until,last_code,observed_conflict_hash,updated_at,completed_at) ON sccrm_fanout.jobs TO ${name}`);
  for(const table of TABLES){
   const exists=(await admin.query("SELECT 1 FROM pg_policies WHERE schemaname='sccrm_fanout' AND tablename=$1 AND policyname='fanout_dedicated_runtime'",[table])).rowCount;
   if(!exists)await admin.query(`CREATE POLICY fanout_dedicated_runtime ON sccrm_fanout.${table} TO ${name} USING(true) WITH CHECK(true)`);
  }
  await admin.query(`ALTER ROLE ${name} SET statement_timeout='8s';ALTER ROLE ${name} SET lock_timeout='1s';ALTER ROLE ${name} SET idle_in_transaction_session_timeout='15s'`);
  await admin.query('COMMIT');return {role,privateSchema:'sccrm_fanout',marker:MARKER};
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
async function checkRuntimeRights(pool){
 const r=(await pool.query(`SELECT current_user actor,has_schema_privilege(current_user,'public','CREATE') public_create,has_column_privilege(current_user,'sccrm_fanout.targets','enabled','UPDATE') can_enable_targets,has_column_privilege(current_user,'sccrm_fanout.sources','profile','UPDATE') can_change_identity,has_table_privilege(current_user,'sccrm_fanout.mappings','UPDATE') can_change_mapping,has_table_privilege(current_user,'sccrm_fanout.mappings','DELETE') can_delete_mapping,has_table_privilege(current_user,'sccrm_fanout.jobs','DELETE') can_delete_queue`)).rows[0];
 if(r.actor!==ROLE||Object.entries(r).some(([key,value])=>key!=='actor'&&value!==false))throw Error('FANOUT_RUNTIME_RIGHTS_EXCESSIVE');return r;
}
async function registerTarget(admin,target){
 if(!/^[a-z0-9_-]{1,100}$/.test(target.targetId)||!/^00[1345]$/.test(target.branchCode)||typeof target.databaseIdentity!=='string'||target.databaseIdentity.length>160)throw Error('FANOUT_TARGET_CONFIG_REFUSED');
 await admin.query('INSERT INTO sccrm_fanout.targets(target_id,database_identity,branch_code) VALUES($1,$2,$3) ON CONFLICT(target_id) DO NOTHING',[target.targetId,target.databaseIdentity,target.branchCode]);
 const r=(await admin.query('SELECT * FROM sccrm_fanout.targets WHERE target_id=$1',[target.targetId])).rows[0];if(r.database_identity!==target.databaseIdentity||r.branch_code!==target.branchCode)throw Error('FANOUT_TARGET_IDENTITY_COLLISION');return r;
}
module.exports={ROLE,TABLES,provisionQueue,checkRuntimeRights,registerTarget};
