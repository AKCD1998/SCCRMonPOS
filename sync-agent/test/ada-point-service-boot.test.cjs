'use strict';
// Importing the exported boot guard must never start the service. All database
// effects below are confined to a fresh fixed-localhost test database.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Client}=require('pg');
const {checkBootRights}=require('../points/run-service.cjs');
const runtime=require('../points/pg-runtime.cjs');
const role=()=>({current_user:'sccrm_ada_points',rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false});
const restricted=()=>({no_membership:true,points_ddl:false,checked_tables:3,external_access:false});
function mockPool(roleRow=role(),rightsRow=restricted()){
 const queries=[];
 return {queries,query:async sql=>{queries.push(sql);return {rows:sql.includes('FROM pg_roles WHERE rolname=current_user')?
  roleRow?[roleRow]:[]:rightsRow?[rightsRow]:[]};}};
}
test('boot guard uses catalog OIDs without needing access to protected external schemas',async()=>{
 const db=mockPool();
 assert.deepEqual(await checkBootRights(db),{ok:true,role:'sccrm_ada_points',externalAccess:false});
 assert.equal(db.queries.length,2);
 assert.match(db.queries[1],/FROM pg_class c JOIN pg_namespace/);
 assert.match(db.queries[1],/has_table_privilege\(current_user,oid,/);
 assert.doesNotMatch(db.queries[1],/has_table_privilege\(current_user,\s*['"]/);
 assert.ok(db.queries.every(sql=>!/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i.test(sql)));
});
for(const [label,change]of [['missing-role',null],['wrong-role',{current_user:'postgres'}],['superuser',{rolsuper:true}],
 ['create-role',{rolcreaterole:true}],['create-database',{rolcreatedb:true}],['bypass-rls',{rolbypassrls:true}]]){
 test('boot guard refuses '+label+' before inspecting protected tables',async()=>{
  const db=mockPool(change===null?null:{...role(),...change});
  await assert.rejects(checkBootRights(db),/POINT_SERVICE_PG_RIGHTS_EXCESSIVE/);assert.equal(db.queries.length,1);
 });
}
for(const [label,change]of [['missing-result',null],['role-membership',{no_membership:false}],['schema-create',{points_ddl:true}],
 ['external-table-grant',{external_access:true}],['unknown-external-access',{external_access:null}],
 ['missing-one-table',{checked_tables:2}],['missing-all-tables',{checked_tables:0}],['unexpected-table-count',{checked_tables:4}]]){
 test('boot guard fails closed for '+label,async()=>{
  const db=mockPool(role(),change===null?null:{...restricted(),...change});
  await assert.rejects(checkBootRights(db),/POINT_SERVICE_PG_RIGHTS_EXCESSIVE/);
 });
}

test('real restricted-role boot works without external schema USAGE and rejects excess/missing scope',
 {skip:process.env.SCCRM_POINTS_COPY_TEST!=='1',timeout:120000},async()=>{
 const control=new Client({host:'127.0.0.1',port:55502,database:'postgres',user:'postgres',connectionTimeoutMillis:3000});
 let db,worker,database,fixtureRole,ownedRole=false,checks=0;
 const check=(value,message)=>{assert.ok(value,message);checks++;};
 const refused=async client=>{await assert.rejects(checkBootRights(client),/POINT_SERVICE_PG_RIGHTS_EXCESSIVE/);checks++;};
 await control.connect();
 try{
  assert.deepEqual((await control.query('SELECT host(inet_server_addr()) host,inet_server_port() port,current_database() db')).rows[0],
   {host:'127.0.0.1',port:55502,db:'postgres'});
  // Same lock as pg-runtime integration tests: one fresh global role at a time.
  await control.query("SELECT pg_advisory_lock(hashtextextended('SCCRM_POINTS_RUNTIME_ROLE_COPY_TEST_V1',0))");
  check(!(await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[runtime.ROLE])).rows.length,'never reuse another operator/test runtime role');
  const suffix=crypto.randomBytes(6).toString('hex');database='sccrm_points_boot_copy_'+suffix;
  await control.query('CREATE DATABASE "'+database+'"');
  db=new Client({host:'127.0.0.1',port:55502,database,user:'postgres',connectionTimeoutMillis:3000});await db.connect();
  await db.query(`CREATE SCHEMA ada_history;REVOKE ALL ON SCHEMA ada_history FROM PUBLIC;
   CREATE TABLE public.member_profiles(user_id uuid,member_code text,is_active boolean);
   ALTER TABLE public.member_profiles ENABLE ROW LEVEL SECURITY;
   CREATE TABLE ada_history.member_links(source_id text,ada_code text,member_id uuid,approval_reference text);
   CREATE TABLE public.point_ledger(id integer PRIMARY KEY,amount integer,note text);
   INSERT INTO public.point_ledger VALUES(1,807,'local preservation fixture')`);
  const before=(await db.query('SELECT md5(to_jsonb(t)::text) hash FROM public.point_ledger t WHERE id=1')).rows[0].hash;
  const password=crypto.randomBytes(40).toString('hex');await runtime.provision(db,{password});ownedRole=true;
  worker=new Client({host:'127.0.0.1',port:55502,database,user:runtime.ROLE,password,connectionTimeoutMillis:3000});await worker.connect();
  check((await worker.query("SELECT has_schema_privilege(current_user,'ada_history','USAGE') allowed")).rows[0].allowed===false,'role intentionally has no external schema usage');
  await assert.rejects(worker.query("SELECT has_table_privilege(current_user,'ada_history.member_links','SELECT')"),e=>e.code==='42501');checks++;
  check((await checkBootRights(worker)).ok,'OID-based boot guard succeeds despite that intentional denial');
  await refused(db); // The broad administrator must not be accepted as runtime.
  for(const table of ['public.point_ledger','public.member_profiles','ada_history.member_links']){
   await db.query('GRANT SELECT ON '+table+' TO sccrm_ada_points');await refused(worker);
   await db.query('REVOKE SELECT ON '+table+' FROM sccrm_ada_points');
   check((await checkBootRights(worker)).ok,'guard recovers after revoking the isolated fixture grant');
  }
  await db.query('GRANT CREATE ON SCHEMA ada_points TO sccrm_ada_points');await refused(worker);
  await db.query('REVOKE CREATE ON SCHEMA ada_points FROM sccrm_ada_points');
  fixtureRole='point_boot_untrusted_'+suffix;await db.query('CREATE ROLE "'+fixtureRole+'" NOLOGIN');
  await db.query('GRANT "'+fixtureRole+'" TO sccrm_ada_points');await refused(worker);
  await db.query('REVOKE "'+fixtureRole+'" FROM sccrm_ada_points');
  for(const [schema,table]of [['public','point_ledger'],['public','member_profiles'],['ada_history','member_links']]){
   const held='boot_hold_'+table;
   await db.query('ALTER TABLE '+schema+'.'+table+' RENAME TO '+held);await refused(worker);
   await db.query('ALTER TABLE '+schema+'.'+held+' RENAME TO '+table);
  }
  check((await checkBootRights(worker)).ok,'all three protected objects restored without granting external access');
  check((await db.query('SELECT md5(to_jsonb(t)::text) hash FROM public.point_ledger t WHERE id=1')).rows[0].hash===before,'local ledger row is byte-for-byte unchanged');
  check((await db.query('SELECT amount FROM public.point_ledger WHERE id=1')).rows[0].amount===807,'807 is only the local fixture baseline');
  console.log(JSON.stringify({ok:true,scope:'LOCAL-POSTGRES-SERVICE-BOOT-COPY-ONLY',checks,productionWrites:0,sqlServerWrites:0,pinRead:false}));
 }finally{
  if(worker)await worker.end().catch(()=>{});if(db)await db.end().catch(()=>{});
  if(database&&/^sccrm_points_boot_copy_[a-f0-9]{12}$/.test(database))await control.query('DROP DATABASE "'+database+'"').catch(()=>{});
  if(ownedRole)await control.query('DROP ROLE sccrm_ada_points').catch(()=>{});
  if(fixtureRole&&/^point_boot_untrusted_[a-f0-9]{12}$/.test(fixtureRole))await control.query('DROP ROLE "'+fixtureRole+'"').catch(()=>{});
  await control.end();
 }
});
