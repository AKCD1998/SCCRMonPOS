'use strict';
// Explicit operator provisioning only. Never invoked by the worker, never opens
// a connection, and never logs/returns the password. Caller supplies a connected
// administrator pg Client. All DDL/grants/role creation commit atomically.
const fs=require('node:fs'),path=require('node:path');
const ROLE='sccrm_ada_points',SCOPE='SCCRM-ADA-PRIMARY-POINTS-V1';
const MARKER='541be1f2-1b99-4d73-9d6a-5ef0a1ef2417';
const READ=['meta','delivery_meta'];
const APPEND=['source_openings','source_audit','projection_journal','delivery_audit'];
const MUTABLE=['sources','source_snapshots','native_events','balance_values','global_state','delivery_targets','delivery_jobs'];
const TABLES=[...READ,...APPEND,...MUTABLE];
const SEQUENCES=['source_audit_id_seq','projection_journal_id_seq','balance_generation_seq','delivery_jobs_id_seq','delivery_audit_id_seq'];
const FUNCTIONS=['delivery_keep_history','delivery_job_guard','delivery_target_guard','delivery_record_change'];
const ident=value=>'"'+String(value).replaceAll('"','""')+'"';
const fail=code=>{throw Object.assign(Error(code),{code});};
const binding=(database,owner)=>'SCCRM-ADA-POINT-RUNTIME-V1:'+database+':'+owner;
async function guardMemberships(db,workerOid,ownerOid){
 const rows=(await db.query(`SELECT m.roleid::text,m.member::text,m.admin_option,
   (to_jsonb(m)->>'inherit_option')::boolean inherit_option,(to_jsonb(m)->>'set_option')::boolean set_option
   FROM pg_auth_members m WHERE m.roleid=$1::oid OR m.member=$1::oid`,[workerOid])).rows;
 // PG16+ grants the creating administrator ADMIN OPTION on its new role.
 // That reverse grant does not give the worker any administrator privileges.
 // Permit only the bound schema owner, without INHERIT or SET when supported.
 if(rows.some(r=>r.member===String(workerOid)||r.roleid!==String(workerOid)||r.member!==String(ownerOid)||
   !r.admin_option||r.inherit_option===true||r.set_option===true))fail('POINT_RUNTIME_ROLE_MEMBERSHIP_REFUSED');
}
async function inventory(db,ownerOid,{complete=false}={}){
 const rows=(await db.query(`SELECT c.relname,c.relkind,c.relowner::text FROM pg_class c
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ada_points' AND c.relkind IN('r','v','S','m','p','f')`)).rows;
 const allowed=new Map([...TABLES.map(t=>[t,'r']),['balance_cache','v'],['approved_owner_links','v'],...SEQUENCES.map(t=>[t,'S'])]);
 if(rows.some(r=>allowed.get(r.relname)!==r.relkind||r.relowner!==String(ownerOid)))fail('POINT_RUNTIME_SCHEMA_COLLISION');
 if(complete&&(rows.length!==allowed.size||rows.some(r=>!allowed.has(r.relname))))fail('POINT_RUNTIME_SCHEMA_INCOMPLETE');
 const funcs=(await db.query(`SELECT p.proname,p.proowner::text,p.prosecdef,p.pronargs
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ada_points'`)).rows;
 if(funcs.some(p=>!FUNCTIONS.includes(p.proname)||p.proowner!==String(ownerOid)||p.prosecdef||p.pronargs!==0))fail('POINT_RUNTIME_FUNCTION_COLLISION');
 if(complete&&funcs.length!==FUNCTIONS.length)fail('POINT_RUNTIME_SCHEMA_INCOMPLETE');
}
async function requireExternalTables(db){
 const tables=(await db.query(`SELECT n.nspname,c.relname FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid IN(to_regclass('public.member_profiles'),to_regclass('ada_history.member_links'))`)).rows;
 if(tables.length!==2)fail('POINT_RUNTIME_EXTERNAL_TABLES_REQUIRED');
 const required={member_profiles:['user_id','member_code'],member_links:['source_id','ada_code','member_id','approval_reference']};
 const columns=(await db.query(`SELECT c.relname,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  WHERE a.attrelid IN('public.member_profiles'::regclass,'ada_history.member_links'::regclass) AND a.attnum>0 AND NOT a.attisdropped`)).rows;
 for(const [table,names]of Object.entries(required))if(names.some(name=>!columns.some(c=>c.relname===table&&c.attname===name)))fail('POINT_RUNTIME_EXTERNAL_COLUMNS_REQUIRED');
}
async function guardPolicies(db,roleOid){
 const rows=(await db.query(`SELECT n.nspname,c.relname,p.polname,array_to_string(p.polroles,',') roles
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='ada_points'`)).rows;
 for(const p of rows){
  if(!['sccrm_ada_points_read','sccrm_ada_points_insert','sccrm_ada_points_update'].includes(p.polname)||p.roles!==String(roleOid))fail('POINT_RUNTIME_POLICY_COLLISION');
 }
}
async function provisionRuntime(db,{password}={}){
 if(!db||typeof db.query!=='function')fail('POINT_RUNTIME_ADMIN_CLIENT_REQUIRED');
 if(typeof password!=='string'||!/^[a-f0-9]{64,128}$/.test(password))fail('POINT_RUNTIME_SAFE_PASSWORD_REQUIRED');
 let started=false,stage='begin';
 try{
  await db.query('BEGIN');started=true;
  await db.query("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('SCCRM_ADA_POINTS_RUNTIME_PROVISION_V1',0))");
  stage='ownership-guards';
  const who=(await db.query(`SELECT current_database() database,current_user owner,r.oid::text owner_oid
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if(!who||who.owner===ROLE)fail('POINT_RUNTIME_ADMIN_ROLE_REQUIRED');
  const expectedBinding=binding(who.database,who.owner_oid);
  const schema=(await db.query("SELECT nspowner::text owner_oid FROM pg_namespace WHERE nspname='ada_points'")).rows[0];
  if(schema){
   if(schema.owner_oid!==who.owner_oid)fail('POINT_RUNTIME_SCHEMA_OWNER_REFUSED');
   await inventory(db,who.owner_oid);
   if(!(await db.query("SELECT to_regclass('ada_points.meta') IS NOT NULL AS present")).rows[0]?.present)fail('POINT_RUNTIME_SCHEMA_NOT_OWNED');
   const meta=(await db.query('SELECT * FROM ada_points.meta')).rows;
   if(meta.length!==1||meta[0].singleton!==true||meta[0].schema_version!==1||meta[0].scope!==SCOPE||meta[0].marker!==MARKER)fail('POINT_RUNTIME_SCHEMA_NOT_OWNED');
  }
  const oldRole=(await db.query(`SELECT oid::text,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
    shobj_description(oid,'pg_authid') description FROM pg_roles WHERE rolname=$1`,[ROLE])).rows[0];
  if(oldRole){
   if(!schema||oldRole.description!==expectedBinding||['rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls'].some(k=>oldRole[k]))fail('POINT_RUNTIME_ROLE_COLLISION');
   await guardMemberships(db,oldRole.oid,who.owner_oid);
   if((await db.query('SELECT 1 FROM pg_class WHERE relowner=$1::oid LIMIT 1',[oldRole.oid])).rows.length)fail('POINT_RUNTIME_ROLE_OWNER_REFUSED');
  }
  await requireExternalTables(db);
  stage='private-schema';
  await db.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
  await db.query(fs.readFileSync(path.join(__dirname,'delivery-schema.sql'),'utf8'));
  // The existing history-link table has RLS disabled in production. Never
  // enable it or grant the worker access to that application's tables. This
  // private trusted-owner view is the deliberate, narrow metadata capability.
  await db.query(`CREATE OR REPLACE VIEW ada_points.approved_owner_links
    WITH(security_barrier=true,security_invoker=false) AS
    SELECT l.member_id::text,l.ada_code,m.member_code AS canonical_code
    FROM ada_history.member_links l JOIN public.member_profiles m ON m.user_id=l.member_id
    WHERE l.source_id='hq000/AdaAcc' AND btrim(l.approval_reference)<>''`);
  await inventory(db,who.owner_oid,{complete:true});
  // Password is validated hex before interpolation; PostgreSQL utility DDL does
  // not accept bind parameters here. Errors below are always sanitized.
  stage=oldRole?'alter-runtime-login':'create-runtime-role';
  // Supabase's postgres administrator has CREATEROLE but is not a superuser.
  // Existing privileged attributes were already verified false above. Repeating
  // NOREPLICATION/NOBYPASSRLS in ALTER still requires superuser on that platform.
  await db.query(oldRole?`ALTER ROLE ${ident(ROLE)} LOGIN PASSWORD '${password}'`:
    `CREATE ROLE ${ident(ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  stage='role-binding';
  await db.query(`COMMENT ON ROLE ${ident(ROLE)} IS '${expectedBinding.replaceAll("'","''")}'`);
  await db.query(`ALTER ROLE ${ident(ROLE)} SET search_path=pg_catalog,ada_points`);
  const roleOid=(await db.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[ROLE])).rows[0].oid;
  await guardPolicies(db,roleOid);
  stage='private-grants';
  await db.query(`REVOKE ALL ON SCHEMA ada_points FROM PUBLIC,${ident(ROLE)};
    REVOKE ALL ON ALL TABLES IN SCHEMA ada_points FROM ${ident(ROLE)};
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA ada_points FROM ${ident(ROLE)};
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ada_points FROM ${ident(ROLE)};
    GRANT USAGE ON SCHEMA ada_points TO ${ident(ROLE)}`);
  const publicRoles=(await db.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated')")).rows;
  for(const role of ['PUBLIC',...publicRoles.map(r=>ident(r.rolname))])await db.query(`REVOKE ALL ON SCHEMA ada_points FROM ${role};
    REVOKE ALL ON ALL TABLES IN SCHEMA ada_points FROM ${role};
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA ada_points FROM ${role};
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ada_points FROM ${role}`);
  for(const table of TABLES){
   const qualified='ada_points.'+ident(table);
   const commands=READ.includes(table)?['SELECT']:APPEND.includes(table)?['SELECT','INSERT']:['SELECT','INSERT','UPDATE'];
   await db.query(`GRANT ${commands.join(',')} ON ${qualified} TO ${ident(ROLE)}`);
   for(const [name,command]of [['read','SELECT'],['insert','INSERT'],['update','UPDATE']]){
    await db.query(`DROP POLICY IF EXISTS ${ident('sccrm_ada_points_'+name)} ON ${qualified}`);
    if(commands.includes(command))await db.query(`CREATE POLICY ${ident('sccrm_ada_points_'+name)} ON ${qualified} FOR ${command} TO ${ident(ROLE)} ${command==='INSERT'?'WITH CHECK (true)':command==='UPDATE'?'USING (true) WITH CHECK (true)':'USING (true)'}`);
   }
  }
  await db.query(`GRANT SELECT ON ada_points.balance_cache,ada_points.approved_owner_links TO ${ident(ROLE)};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ada_points TO ${ident(ROLE)};
    GRANT CONNECT ON DATABASE ${ident(who.database)} TO ${ident(ROLE)}`);
  // Positive grants inherited through PUBLIC cannot be negated for one role.
  // Refuse rather than weaken unrelated applications' existing privileges.
  stage='postflight';
  const unsafe=(await db.query(`SELECT has_database_privilege($1,current_database(),'CREATE') db_create,
    has_schema_privilege($1,'public','CREATE') public_create,has_schema_privilege($1,'ada_history','CREATE') history_create,
    has_schema_privilege($1,'ada_points','CREATE') points_create,
    has_table_privilege($1,'public.member_profiles','INSERT,UPDATE,DELETE,TRUNCATE') profile_write,
    has_table_privilege($1,'ada_history.member_links','INSERT,UPDATE,DELETE,TRUNCATE') links_write`,[ROLE])).rows[0];
  if(Object.values(unsafe).some(Boolean))fail('POINT_RUNTIME_INHERITED_PRIVILEGE_REFUSED');
  const externalAccess=(await db.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN('public','ada_history') AND c.relkind IN('r','v','m','p','f')
      AND(has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`,[ROLE])).rows;
  if(externalAccess.length)fail('POINT_RUNTIME_PUBLIC_DATA_PRIVILEGE_REFUSED');
  stage='commit';await db.query('COMMIT');started=false;
  return {ok:true,scope:SCOPE,role:ROLE,createdRole:!oldRole,createdSchema:!schema,tables:TABLES.length,sequences:SEQUENCES.length,
    immutableTables:APPEND.slice(),operatorControlled:true,passwordReturned:false};
 }catch(error){
  if(started)await db.query('ROLLBACK').catch(()=>{});
  const code=/^POINT_RUNTIME_[A-Z_]+$/.test(error?.code||error?.message||'')?(error.code||error.message):'POINT_RUNTIME_PROVISION_FAILED';
  throw Object.assign(Error(code),{code,stage,
    ...(/^[A-Z0-9]{5}$/.test(error?.code||'')?{sqlState:error.code}:{}),
    ...(/^[A-Za-z0-9_]{1,80}$/.test(error?.routine||'')?{routine:error.routine}:{})});
 }
}

async function checkRights(db){
 if(!db||typeof db.query!=='function')fail('POINT_RUNTIME_CLIENT_REQUIRED');
 try{
  const role=(await db.query(`SELECT current_user name,current_database() database,r.oid::text,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
    r.rolinherit,r.rolreplication,r.rolbypassrls,shobj_description(r.oid,'pg_authid') description FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if(!role||role.name!==ROLE||!role.rolcanlogin||['rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls'].some(k=>role[k]))fail('POINT_RUNTIME_ROLE_RIGHTS_REFUSED');
  const ownership=(await db.query(`SELECT nspowner::text,has_schema_privilege(current_user,oid,'USAGE') can_use,
    has_schema_privilege(current_user,oid,'CREATE') can_create FROM pg_namespace WHERE nspname='ada_points'`)).rows[0];
  if(!ownership||ownership.nspowner===role.oid||!ownership.can_use||ownership.can_create)fail('POINT_RUNTIME_SCHEMA_RIGHTS_REFUSED');
  if(role.description!==binding(role.database,ownership.nspowner))fail('POINT_RUNTIME_ROLE_BINDING_REFUSED');
  await guardMemberships(db,role.oid,ownership.nspowner);
  const rows=(await db.query(`SELECT c.relname,c.relkind,c.relrowsecurity,c.relowner::text,
    has_table_privilege(current_user,c.oid,'SELECT') sel,has_table_privilege(current_user,c.oid,'INSERT') ins,
    has_table_privilege(current_user,c.oid,'UPDATE') upd,has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') extra
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ada_points' AND c.relkind IN('r','v','m','p','f')`)).rows;
  if(rows.length!==TABLES.length+2)fail('POINT_RUNTIME_TABLE_RIGHTS_REFUSED');
  for(const r of rows){
   const view=['balance_cache','approved_owner_links'].includes(r.relname),append=APPEND.includes(r.relname),mutable=MUTABLE.includes(r.relname);
   if((view?r.relkind!=='v':!TABLES.includes(r.relname)||r.relkind!=='r'||!r.relrowsecurity)||r.relowner===role.oid||!r.sel||
     r.ins!==(append||mutable)||r.upd!==mutable||r.extra)fail('POINT_RUNTIME_TABLE_RIGHTS_REFUSED');
  }
  await guardPolicies(db,role.oid);
  const policies=(await db.query(`SELECT c.relname,p.polname,p.polcmd,p.polpermissive,
    pg_get_expr(p.polqual,p.polrelid) qual,pg_get_expr(p.polwithcheck,p.polrelid) check_expr
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='ada_points'::regnamespace`)).rows;
  const expectedPolicies=READ.length+APPEND.length*2+MUTABLE.length*3;
  if(policies.length!==expectedPolicies)fail('POINT_RUNTIME_POLICY_RIGHTS_REFUSED');
  for(const p of policies){
   const command={sccrm_ada_points_read:'r',sccrm_ada_points_insert:'a',sccrm_ada_points_update:'w'}[p.polname];
   if(p.polcmd!==command||!p.polpermissive||command==='r'&&p.qual!=='true'||command==='a'&&p.check_expr!=='true'||
     command==='w'&&(p.qual!=='true'||p.check_expr!=='true')||command==='a'&&!APPEND.includes(p.relname)&&!MUTABLE.includes(p.relname)||
     command==='w'&&!MUTABLE.includes(p.relname))fail('POINT_RUNTIME_POLICY_RIGHTS_REFUSED');
  }
  const seq=(await db.query(`SELECT c.relname,has_sequence_privilege(current_user,c.oid,'USAGE') usage,
    has_sequence_privilege(current_user,c.oid,'SELECT') sel,has_sequence_privilege(current_user,c.oid,'UPDATE') upd
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ada_points' AND c.relkind='S'`)).rows;
  if(seq.length!==SEQUENCES.length||seq.some(s=>!SEQUENCES.includes(s.relname)||!s.usage||!s.sel||s.upd))fail('POINT_RUNTIME_SEQUENCE_RIGHTS_REFUSED');
  const outside=(await db.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN('public','ada_history') AND c.relkind IN('r','v','m','p','f')
     AND(has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`)).rows;
  if(outside.length)fail('POINT_RUNTIME_PUBLIC_DATA_PRIVILEGE_REFUSED');
  const ddl=(await db.query(`SELECT has_database_privilege(current_user,current_database(),'CREATE') db,
    has_schema_privilege(current_user,'public','CREATE') public,has_schema_privilege(current_user,'ada_history','CREATE') history`)).rows[0];
  if(Object.values(ddl).some(Boolean))fail('POINT_RUNTIME_INHERITED_PRIVILEGE_REFUSED');
  const markers=(await db.query(`SELECT m.scope,m.marker::text,d.marker::text delivery_marker
    FROM ada_points.meta m CROSS JOIN ada_points.delivery_meta d WHERE m.singleton AND d.singleton`)).rows;
  if(markers.length!==1||markers[0].scope!==SCOPE||markers[0].marker!==MARKER||markers[0].delivery_marker!=='fcd9c461-328b-4519-8a61-cea0cb46fe22')fail('POINT_RUNTIME_MARKER_REFUSED');
  const view=(await db.query(`SELECT reloptions FROM pg_class WHERE oid='ada_points.approved_owner_links'::regclass`)).rows[0];
  if(!view?.reloptions?.includes('security_barrier=true')||!view.reloptions.includes('security_invoker=false'))fail('POINT_RUNTIME_OWNER_VIEW_REFUSED');
  const exposed=(await db.query(`SELECT r.rolname FROM pg_roles r WHERE r.rolname IN('anon','authenticated') AND(
    has_schema_privilege(r.oid,'ada_points','USAGE,CREATE') OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='ada_points' AND c.relkind IN('r','v') AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')))`)).rows;
  if(exposed.length)fail('POINT_RUNTIME_PUBLIC_EXPOSURE_REFUSED');
  return {ok:true,role:ROLE,tables:TABLES.length,views:2,sequences:seq.length,externalTableAccess:false,
    ledgerAccess:false,directDelete:false,ddl:false,scope:SCOPE};
 }catch(error){const code=/^POINT_RUNTIME_[A-Z_]+$/.test(error?.code||error?.message||'')?(error.code||error.message):'POINT_RUNTIME_RIGHTS_FAILED';throw Object.assign(Error(code),{code});}
}
module.exports={ROLE,SCOPE,MARKER,TABLES,APPEND,MUTABLE,SEQUENCES,provisionRuntime,provision:provisionRuntime,checkRights};
