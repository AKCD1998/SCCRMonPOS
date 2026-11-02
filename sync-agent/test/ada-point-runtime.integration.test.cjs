'use strict';
// Fixed localhost PostgreSQL only. No Supabase, SQL Server, service or GUI call.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Client}=require('pg');
const runtime=require('../points/pg-runtime.cjs');
const RUN=process.env.SCCRM_POINTS_COPY_TEST==='1';
const BASE='postgresql://postgres@127.0.0.1:55502/postgres';
const sha=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
test('private runtime role and approved ownership capability on localhost copy',{skip:!RUN,timeout:120000},async()=>{
 const control=new Client({connectionString:BASE,connectionTimeoutMillis:3000});let db,database,ownedRole=false,fixtureRole;let checks=0;
 const check=(value,message)=>{assert.ok(value,message);checks++;};
 const denied=async(sql,values)=>{await assert.rejects(db.query(sql,values),e=>e.code==='42501');checks++;};
 await control.connect();
 try{
  const endpoint=(await control.query('SELECT host(inet_server_addr()) host,inet_server_port() port,current_database() db')).rows[0];
  assert.deepEqual(endpoint,{host:'127.0.0.1',port:55502,db:'postgres'});
  await control.query("SELECT pg_advisory_lock(hashtextextended('SCCRM_POINTS_RUNTIME_ROLE_COPY_TEST_V1',0))");
  check(!(await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[runtime.ROLE])).rows.length,'do not reuse another test/operator role');
  database='sccrm_points_runtime_copy_'+crypto.randomBytes(6).toString('hex');
  assert.match(database,/^sccrm_points_runtime_copy_[a-f0-9]{12}$/);
  await control.query('CREATE DATABASE "'+database+'"');
  const url=new URL(BASE);url.pathname='/'+database;db=new Client({connectionString:url.href});await db.connect();
  await db.query(`CREATE SCHEMA ada_history;
    CREATE TABLE public.member_profiles(user_id uuid PRIMARY KEY,member_code text,is_active boolean,private_note text);
    ALTER TABLE public.member_profiles ENABLE ROW LEVEL SECURITY;
    CREATE TABLE ada_history.member_links(source_id text,ada_code text,member_id uuid,approval_reference text,private_note text);
    CREATE TABLE public.users(id uuid PRIMARY KEY,private_note text);
    CREATE TABLE public.point_ledger(id integer PRIMARY KEY,amount integer NOT NULL,note text);
    INSERT INTO public.point_ledger VALUES(1,807,'existing archived ledger');
    INSERT INTO public.users VALUES('00000000-0000-4000-8000-000000000001','never readable by runtime');
    INSERT INTO public.member_profiles VALUES
      ('00000000-0000-4000-8000-000000000001','AR001-000001',true,'private profile'),
      ('00000000-0000-4000-8000-000000000002','AR001-000002',false,'inactive historical ownership');
    INSERT INTO ada_history.member_links VALUES
      ('hq000/AdaAcc','AR001-000001','00000000-0000-4000-8000-000000000001','approved','private link'),
      ('hq000/AdaAcc','AR001-000002','00000000-0000-4000-8000-000000000002','approved','private link'),
      ('hq000/AdaAcc','AR001-000003','00000000-0000-4000-8000-000000000001','  ','unapproved'),
      ('branch001/AdaAcc','AR001-000004','00000000-0000-4000-8000-000000000001','approved','different source');
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;END $$`);
  const before=(await db.query("SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) digest,sum(amount)::text balance FROM public.point_ledger t")).rows[0];
  const externalBefore=(await db.query("SELECT oid::text,relrowsecurity,COALESCE(relacl::text,'') acl FROM pg_class WHERE oid IN('public.member_profiles'::regclass,'ada_history.member_links'::regclass) ORDER BY oid")).rows;
  await assert.rejects(runtime.provision(db,{password:"not-safe'; SET ROLE postgres;--"}),{code:'POINT_RUNTIME_SAFE_PASSWORD_REQUIRED'});checks++;
  const password=crypto.randomBytes(40).toString('hex');
  const provisioned=await runtime.provision(db,{password});ownedRole=true;
  check(provisioned.ok&&provisioned.tables===13&&provisioned.sequences===5&&provisioned.createdRole,'latest projection9 plus delivery4 tables provisioned');
  check(!JSON.stringify(provisioned).includes(password),'password never returned');
  const version=Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
  await db.query(version>=160000?'GRANT sccrm_ada_points TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE':'GRANT sccrm_ada_points TO postgres WITH ADMIN OPTION');
  const repeated=await runtime.provision(db,{password:crypto.randomBytes(40).toString('hex')});
  check(repeated.ok&&!repeated.createdRole&&!repeated.createdSchema,'owned role/schema provisioning is idempotent');
  check((await db.query("SELECT admin_option FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='sccrm_ada_points') AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')")).rows[0]?.admin_option,'trusted creator reverse ADMIN grant is retained');
  const externalAfter=(await db.query("SELECT oid::text,relrowsecurity,COALESCE(relacl::text,'') acl FROM pg_class WHERE oid IN('public.member_profiles'::regclass,'ada_history.member_links'::regclass) ORDER BY oid")).rows;
  assert.deepEqual(externalAfter,externalBefore);checks++;
  check((await db.query("SELECT count(*)::int n FROM pg_policy WHERE polrelid IN('public.member_profiles'::regclass,'ada_history.member_links'::regclass)")).rows[0].n===0,'external RLS and policies are unchanged');
  await db.query('SET ROLE sccrm_ada_points');
  check((await runtime.checkRights(db)).ok,'strict runtime rights verification passes under SET ROLE');
  const links=(await db.query('SELECT * FROM ada_points.approved_owner_links ORDER BY ada_code')).rows;
  assert.deepEqual(links,[
    {member_id:'00000000-0000-4000-8000-000000000001',ada_code:'AR001-000001',canonical_code:'AR001-000001'},
    {member_id:'00000000-0000-4000-8000-000000000002',ada_code:'AR001-000002',canonical_code:'AR001-000002'},
  ]);checks++;
  for(const sql of ['SELECT * FROM public.member_profiles','SELECT * FROM ada_history.member_links','SELECT * FROM public.users',
    'SELECT * FROM public.point_ledger',"INSERT INTO public.point_ledger VALUES(2,99,'forbidden')",'UPDATE public.point_ledger SET amount=0',
    'DELETE FROM public.point_ledger','TRUNCATE public.point_ledger','CREATE TABLE public.forbidden(id int)',
    'CREATE TABLE ada_points.forbidden(id int)','ALTER TABLE ada_points.sources ADD COLUMN forbidden int',
    'DELETE FROM ada_points.sources','TRUNCATE ada_points.native_events','UPDATE ada_points.meta SET schema_version=1',
    'UPDATE ada_points.source_openings SET initial_opening=0','UPDATE ada_points.source_audit SET customer_count=0',
    'UPDATE ada_points.projection_journal SET revision=revision','UPDATE ada_points.delivery_audit SET code=code',
    "SELECT setval('ada_points.balance_generation_seq',1)"]){await denied(sql);}
  check(!(await db.query("SELECT has_table_privilege(current_user,'ada_points.approved_owner_links','INSERT') allowed")).rows[0].allowed,'ownership view has no write grant');
  await assert.rejects(db.query("INSERT INTO ada_points.approved_owner_links VALUES('x','x','x')"),e=>e.code==='42501'||e.code==='55000');checks++;
  await db.query("INSERT INTO ada_points.sources VALUES('005','COPY005','COPY','COPY',$1,$1,clock_timestamp())",[sha('fixture')]);
  await db.query("INSERT INTO ada_points.source_openings(branch_code,ada_code,initial_opening,first_payload_hash) VALUES('005','AR001-000001','12',$1)",[sha('fixture')]);
  await db.query("UPDATE ada_points.sources SET observed_at=clock_timestamp() WHERE branch_code='005'");
  await db.query("INSERT INTO ada_points.source_audit(branch_code,payload_hash,source_identity,schema_hash,observed_at,customer_count,point_count,balance_count) VALUES('005',$1,'COPY005',$1,clock_timestamp(),1,1,1)",[sha('fixture')]);
  await db.query("INSERT INTO ada_points.balance_values(ada_code,balance,state,version,details) VALUES('AR001-000001',12,'ready',$1,'{}')",[sha('fixture')]);
  await db.query("INSERT INTO ada_points.projection_journal(ada_code,new_value,revision,generation) VALUES('AR001-000001','{}',$1,1)",[sha('fixture')]);
  await db.query("UPDATE ada_points.global_state SET state='ready',observed_at=clock_timestamp(),revision=$1",[sha('fixture')]);
  await db.query("INSERT INTO ada_points.delivery_targets(target_id,database_identity,branch_code) VALUES('copy005','COPY005','005')");
  await db.query(`INSERT INTO ada_points.delivery_jobs(target_id,database_identity,ada_code,generation,expected_intrinsic,target_balance,projection_version,operation_id,source_observed_at)
    VALUES('copy005','COPY005','AR001-000001',1,12,12,$1,$2,clock_timestamp())`,[sha('fixture'),crypto.randomUUID()]);
  check((await db.query('SELECT count(*)::int n FROM ada_points.delivery_audit')).rows[0].n===1,'runtime insert trigger can append durable audit without EXECUTE grant');
  check((await db.query("SELECT balance::text FROM ada_points.balance_cache WHERE ada_code='AR001-000001'")).rows[0].balance==='12.00000000000000000','worker can read its native cache without old ledger');
  const policies=(await db.query("SELECT count(*)::int n FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='ada_points'::regnamespace AND NOT((SELECT oid FROM pg_roles WHERE rolname=current_user)=ANY(p.polroles))")).rows[0].n;
  check(policies===0,'all private RLS policies address only the runtime role');
  for(const role of ['anon','authenticated']){
    await db.query('RESET ROLE');await db.query('SET ROLE '+role);
    await denied('SELECT * FROM ada_points.balance_cache');await denied('SELECT * FROM ada_points.approved_owner_links');
  }
  await db.query('RESET ROLE');
  fixtureRole='point_runtime_untrusted_'+crypto.randomBytes(5).toString('hex');
  await db.query('CREATE ROLE "'+fixtureRole+'" NOLOGIN');
  await db.query('GRANT sccrm_ada_points TO "'+fixtureRole+'"');
  await assert.rejects(runtime.provision(db,{password}),{code:'POINT_RUNTIME_ROLE_MEMBERSHIP_REFUSED'});checks++;
  await db.query('SET ROLE sccrm_ada_points');
  await assert.rejects(runtime.checkRights(db),{code:'POINT_RUNTIME_ROLE_MEMBERSHIP_REFUSED'});checks++;
  await db.query('RESET ROLE');await db.query('REVOKE sccrm_ada_points FROM "'+fixtureRole+'"');
  await db.query('GRANT "'+fixtureRole+'" TO sccrm_ada_points');
  await assert.rejects(runtime.provision(db,{password}),{code:'POINT_RUNTIME_ROLE_MEMBERSHIP_REFUSED'});checks++;
  await db.query('SET ROLE sccrm_ada_points');
  await assert.rejects(runtime.checkRights(db),{code:'POINT_RUNTIME_ROLE_MEMBERSHIP_REFUSED'});checks++;
  await db.query('RESET ROLE');await db.query('REVOKE "'+fixtureRole+'" FROM sccrm_ada_points');
  const after=(await db.query("SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) digest,sum(amount)::text balance FROM public.point_ledger t")).rows[0];
  assert.deepEqual(after,before);check(after.balance==='807','old ledger807 unchanged');
  // An unexpected private object or policy must not be silently adopted/revoked.
  await db.query('CREATE TABLE ada_points.unrelated(id int)');
  await assert.rejects(runtime.provision(db,{password}),{code:'POINT_RUNTIME_SCHEMA_COLLISION'});checks++;
  await db.query('DROP TABLE ada_points.unrelated');
  await db.query('CREATE POLICY unrelated_read ON ada_points.sources FOR SELECT TO PUBLIC USING(true)');
  await assert.rejects(runtime.provision(db,{password}),{code:'POINT_RUNTIME_POLICY_COLLISION'});checks++;
  await db.query('DROP POLICY unrelated_read ON ada_points.sources');
  await db.query('COMMENT ON ROLE sccrm_ada_points IS \'not-owned\'');
  await assert.rejects(runtime.provision(db,{password}),{code:'POINT_RUNTIME_ROLE_COLLISION'});checks++;
  check((await db.query('SELECT sum(amount)::text balance FROM public.point_ledger')).rows[0].balance==='807','refused provisioning also preserves old ledger');
  console.log(JSON.stringify({ok:true,scope:'LOCAL-POSTGRES-POINT-RUNTIME-COPY-ONLY',database,checks,oldLedger:'807',productionWrites:0,sqlServerWrites:0,pinRead:false}));
 }finally{
  if(db){await db.query('RESET ROLE').catch(()=>{});await db.end().catch(()=>{});}
  // Remove only the fresh local test database and the role created by this run.
  if(database&&/^sccrm_points_runtime_copy_[a-f0-9]{12}$/.test(database))await control.query('DROP DATABASE "'+database+'"').catch(()=>{});
  if(ownedRole)await control.query('DROP ROLE sccrm_ada_points').catch(()=>{});
  if(fixtureRole&&/^point_runtime_untrusted_[a-f0-9]{10}$/.test(fixtureRole))await control.query('DROP ROLE "'+fixtureRole+'"').catch(()=>{});
  await control.end();
 }
});

test('a non-superuser CREATEROLE owner can safely reprovision its runtime login',{skip:!RUN,timeout:120000},async()=>{
 const control=new Client({connectionString:BASE,connectionTimeoutMillis:3000});let admin,worker,database,creator,ownedWorker=false;let checks=0;
 const check=(value,message)=>{assert.ok(value,message);checks++;};
 await control.connect();
 try{
  assert.deepEqual((await control.query('SELECT host(inet_server_addr()) host,inet_server_port() port,current_database() db')).rows[0],
    {host:'127.0.0.1',port:55502,db:'postgres'});
  await control.query("SELECT pg_advisory_lock(hashtextextended('SCCRM_POINTS_RUNTIME_ROLE_COPY_TEST_V1',0))");
  check(!(await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[runtime.ROLE])).rows.length,'never adopt another runtime test role');
  const suffix=crypto.randomBytes(6).toString('hex');creator='point_runtime_creator_'+suffix;database='sccrm_points_runtime_copy_'+suffix;
  await control.query('CREATE ROLE "'+creator+'" LOGIN CREATEROLE NOINHERIT');
  await control.query('CREATE DATABASE "'+database+'" OWNER "'+creator+'"');
  admin=new Client({host:'127.0.0.1',port:55502,database,user:creator,connectionTimeoutMillis:3000});await admin.connect();
  check((await admin.query('SELECT rolsuper,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper===false,'fixture administrator is not superuser');
  await admin.query(`CREATE SCHEMA ada_history;CREATE TABLE public.member_profiles(user_id uuid,member_code text,is_active boolean);
    ALTER TABLE public.member_profiles ENABLE ROW LEVEL SECURITY;
    CREATE TABLE ada_history.member_links(source_id text,ada_code text,member_id uuid,approval_reference text);
    CREATE TABLE public.point_ledger(amount integer);INSERT INTO public.point_ledger VALUES(807)`);
  const first=await runtime.provision(admin,{password:crypto.randomBytes(40).toString('hex')});ownedWorker=true;
  check(first.ok&&first.createdRole,'non-superuser can create the restricted runtime role');
  // On PG16+ CREATEROLE creates this reverse ADMIN-only membership itself.
  const membership=(await admin.query(`SELECT m.admin_option,(to_jsonb(m)->>'inherit_option')::boolean inherit_option,
    (to_jsonb(m)->>'set_option')::boolean set_option FROM pg_auth_members m
    WHERE m.roleid=(SELECT oid FROM pg_roles WHERE rolname=$1) AND m.member=(SELECT oid FROM pg_roles WHERE rolname=current_user)`,[runtime.ROLE])).rows[0];
  const version=Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
  if(version>=160000)check(membership?.admin_option&&membership.inherit_option===false&&membership.set_option===false,'real role-creator grant matches production flags');
  const rotated=crypto.randomBytes(40).toString('hex');
  const second=await runtime.provision(admin,{password:rotated});
  check(second.ok&&!second.createdRole&&!second.createdSchema,'reprovision changes only the login password after checking safe flags');
  worker=new Client({host:'127.0.0.1',port:55502,database,user:runtime.ROLE,password:rotated,connectionTimeoutMillis:3000});await worker.connect();
  check((await runtime.checkRights(worker)).ok,'actual runtime login retains all least-privilege restrictions');
  await assert.rejects(worker.query('SELECT amount FROM public.point_ledger'),e=>e.code==='42501');checks++;
  check((await admin.query('SELECT sum(amount)::text balance FROM public.point_ledger')).rows[0].balance==='807','local archived ledger remains untouched');
  console.log(JSON.stringify({ok:true,scope:'LOCAL-POSTGRES-NONSUPER-RUNTIME-COPY-ONLY',checks,productionWrites:0,sqlServerWrites:0,pinRead:false}));
 }finally{
  if(worker)await worker.end().catch(()=>{});if(admin)await admin.end().catch(()=>{});
  if(database&&/^sccrm_points_runtime_copy_[a-f0-9]{12}$/.test(database))await control.query('DROP DATABASE "'+database+'"').catch(()=>{});
  if(ownedWorker)await control.query('DROP ROLE sccrm_ada_points').catch(()=>{});
  if(creator&&/^point_runtime_creator_[a-f0-9]{12}$/.test(creator))await control.query('DROP ROLE "'+creator+'"').catch(()=>{});
  await control.end();
 }
});
