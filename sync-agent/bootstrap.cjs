'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');const {Client}=require('pg');const {read,MARKER}=require('./config.cjs');const {SqlCopy,Bridge}=require('./bridge.cjs');
const runtime=path.join(__dirname,'runtime');
const stateSql=`CREATE TABLE sync_worker_meta(marker text PRIMARY KEY, initialized boolean NOT NULL DEFAULT false);
CREATE TABLE sync_legacy_ada_codes(ada_code varchar(20) PRIMARY KEY);
CREATE TABLE sync_reviewed_ada_aliases(user_id uuid NOT NULL,ada_code varchar(20) NOT NULL,phone varchar(30) NOT NULL,PRIMARY KEY(user_id,ada_code,phone));
CREATE TABLE sync_member_state(user_id uuid PRIMARY KEY REFERENCES users(id),ada_code varchar(20) NOT NULL UNIQUE,pg_base jsonb NOT NULL,ada_base jsonb NOT NULL);
CREATE TABLE sync_profile_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,decisions jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sync_point_state(event_key varchar(200) PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),applied_amount integer NOT NULL);
CREATE TABLE sync_point_receipt(receipt_id uuid PRIMARY KEY,event_key varchar(200) NOT NULL,user_id uuid NOT NULL,target_amount integer NOT NULL,applied_delta integer NOT NULL);
CREATE TABLE sync_point_sources(user_id uuid NOT NULL REFERENCES users(id),event_key varchar(200) NOT NULL,origin varchar(10) NOT NULL CHECK(origin IN ('pg','ada')),source_version integer NOT NULL,amount integer NOT NULL,origin_event_id uuid NOT NULL,PRIMARY KEY(user_id,event_key,origin));
CREATE TABLE sync_native_observed(raw_key text PRIMARY KEY,event_key varchar(200) NOT NULL,user_id uuid NOT NULL,amount integer NOT NULL,payload_hash text NOT NULL,baseline boolean NOT NULL);
CREATE TABLE sync_reviews(key text PRIMARY KEY,code text NOT NULL,first_seen timestamptz NOT NULL DEFAULT now(),last_seen timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 1);`;
function command(exe,args,input){const r=spawnSync(exe,args,{input,encoding:'utf8',stdio:/pg_ctl\.exe$/i.test(exe)?'ignore':'pipe',windowsHide:true,timeout:60000,maxBuffer:2e6});if(r.status!==0)throw Error('PRIVATE_PG_COMMAND_FAILED');return r.stdout;}
function pgControl(c,action){return command(path.join(c.pg.binDir,'pg_ctl.exe'),['-D',path.join(runtime,'pgdata'),'-w','-t','30',...(action==='start'?['-l',path.join(runtime,'postgres.log'),'start']:['stop','-m','fast'])]);}
async function startPg(c){
 const data=path.join(runtime,'pgdata');fs.mkdirSync(runtime,{recursive:true});
 if(!fs.existsSync(path.join(data,'PG_VERSION'))){
  if(fs.existsSync(data)&&fs.readdirSync(data).length)throw Error('UNKNOWN_PG_DIRECTORY');
  const pass=path.join(runtime,'init-password.secrets');fs.writeFileSync(pass,c.pg.adminPassword,{flag:'wx'});
  try{command(path.join(c.pg.binDir,'initdb.exe'),['-D',data,'-U','sccrm_lab_admin','--auth=scram-sha-256','--encoding=UTF8','--no-locale','--pwfile='+pass]);}finally{fs.unlinkSync(pass);}
  fs.appendFileSync(path.join(data,'postgresql.conf'),"\nlisten_addresses='127.0.0.1'\nport=55443\nmax_connections=12\nshared_buffers='16MB'\nwal_level=minimal\nmax_wal_senders=0\nmax_wal_size='128MB'\n");
 }
 const check=spawnSync(path.join(c.pg.binDir,'pg_ctl.exe'),['-D',data,'status'],{windowsHide:true,stdio:'ignore'});if(check.status!==0)pgControl(c,'start');
}
async function setup(c,file){
 await startPg(c);
 const admin=new Client({...c.pg,user:'sccrm_lab_admin',password:c.pg.adminPassword,database:'postgres',connectionTimeoutMillis:5000});await admin.connect();
 try{
  if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='sccrm_sync_worker'")).rowCount){if(!/^[a-f0-9]{48}$/.test(c.pg.password))throw Error('INVALID_TEST_PASSWORD');await admin.query(`CREATE ROLE sccrm_sync_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${c.pg.password}'`);}
  if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[c.pg.database])).rowCount)await admin.query('CREATE DATABASE sccrm_hq_sync_copy OWNER sccrm_sync_worker');
 }finally{await admin.end();}
 const pg=new Client({...c.pg,connectionTimeoutMillis:5000,query_timeout:10000});await pg.connect();const ada=new SqlCopy(file,true);
 try{
  const has=(await pg.query("SELECT to_regclass('public.sync_worker_meta') n")).rows[0].n;
  if(!has){
   const meta=JSON.parse(fs.readFileSync(path.join(__dirname,'pg-schema-metadata.json')));const ident=s=>{if(!/^[a-z_]+$/.test(s))throw Error('UNSAFE_SCHEMA');return '"'+s+'"';};
   await pg.query('BEGIN');try{
    for(const table of ['users','member_profiles','point_ledger']){
     const cols=meta.columns.filter(c=>c.table_name===table).map(col=>{let t=({uuid:'uuid',text:'text',boolean:'boolean',integer:'integer',date:'date','timestamp with time zone':'timestamptz'})[col.data_type];if(col.data_type==='character varying')t='varchar('+Number(col.character_maximum_length)+')';if(!t)throw Error('UNSUPPORTED_SCHEMA');return ident(col.column_name)+' '+t+(col.is_nullable==='NO'?' NOT NULL':'')+(col.column_default?' DEFAULT '+col.column_default:'');});await pg.query('CREATE TABLE '+ident(table)+'('+cols.join(',')+')');
     for(const con of meta.constraints.filter(c=>c.table_name===table))await pg.query('ALTER TABLE '+ident(table)+' ADD CONSTRAINT '+ident(con.conname)+' '+con.definition);
    }
    await pg.query(stateSql);await pg.query('INSERT INTO sync_worker_meta(marker) VALUES($1)',[MARKER]);await pg.query('COMMIT');
   }catch(e){await pg.query('ROLLBACK');throw e;}
  }
  const marker=(await pg.query('SELECT * FROM sync_worker_meta')).rows;if(marker.length!==1||marker[0].marker!==MARKER)throw Error('PG_COPY_MARKER_REQUIRED');
  if(marker[0].initialized)return;
  for(const filename of ['sql-schema.sql','sql-procedures.sql'])for(let batch of fs.readFileSync(path.join(__dirname,filename),'utf8').split(/^GO\s*$/mi).filter(s=>s.trim())){
   const found=batch.match(/CREATE PROCEDURE dbo\.(SCCRM_[A-Za-z]+)/);if(found){if((await ada.query('SELECT OBJECT_ID(@n) n',{n:'dbo.'+found[1]}))[0].n)batch=batch.replace('CREATE PROCEDURE','ALTER PROCEDURE');}
   await ada.query(batch);
  }
  const original=await ada.query("SELECT FTCstCode code,FTCstName name,FTCstTel phone,ISNULL(FTCstEmail,'') email FROM dbo.TCNMCst");if(original.length!==11)throw Error('INITIAL_COPY_SCOPE_CHANGED');
  for(const a of original)await pg.query('INSERT INTO sync_legacy_ada_codes VALUES($1) ON CONFLICT DO NOTHING',[a.code]);
  const mappings=[['310b5337-d092-4ccb-bdcc-4decac3a367f','SCM-310B5337','AR004-000095'],['ad4a451b-39b1-40c5-9936-0e38ba88623e','SCM-AD4A451B','AR004-000107'],['bb0a6e6c-1952-4b15-aa38-b60519e10846','SCM-BB0A6E6C','AR005-000031']];const bridge=new Bridge(pg,ada);
  for(const [id,member,code] of mappings){
   const a=original.find(a=>a.code===code);await pg.query("INSERT INTO users(id,full_name,phone_number,email) VALUES($1,$2,$3,NULLIF($4,'')) ON CONFLICT(id) DO NOTHING",[id,a.name,a.phone,a.email]);await pg.query('INSERT INTO member_profiles(user_id,member_code) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',[id,member]);await bridge.map(id,code);
   for(const alias of original.filter(o=>o.phone.replace(/\D/g,'')===a.phone.replace(/\D/g,'')))await pg.query('INSERT INTO sync_reviewed_ada_aliases VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,alias.code,a.phone]);
   const n=Number((await ada.query('SELECT FNPntPoint n FROM dbo.VCN_TCNMPdtCstPointAmt WHERE FTCstCode=@code',{code}))[0].n);if(n)await pg.query("INSERT INTO point_ledger(user_id,amount,type,reference_id,note,created_by) SELECT $1,$2,'adjustment',$3,'copy baseline','SCCRM_BASELINE' WHERE NOT EXISTS(SELECT 1 FROM point_ledger WHERE user_id=$1)",[id,n,'baseline:'+code]);
  }
  const {Engine}=require('./engine.cjs');const engine=new Engine(pg,ada);await engine.capture(true);await pg.query('UPDATE sync_worker_meta SET initialized=true');
 }finally{ada.close();await pg.end();}
}
if(require.main===module){const file=process.env.SCCRM_SYNC_CONFIG||path.join(runtime,'config.json');setup(read(file),file).then(()=>console.log('SANDBOX_BOOTSTRAP_OK')).catch(()=>{console.error('SANDBOX_BOOTSTRAP_FAILED');process.exitCode=1;});}
module.exports={setup,startPg,pgControl};
