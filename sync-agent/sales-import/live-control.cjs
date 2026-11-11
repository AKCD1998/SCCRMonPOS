'use strict';
const fs=require('node:fs'),path=require('node:path');const c=require('./control.cjs');
const remote='\\\\100.90.166.72\\D\\SCCRM-HQ-LiveSync-20261024\\sales-import';
function own(){const o=JSON.parse(fs.readFileSync(path.join(remote,'.sales-import-owner.json')));if(o.marker!==c.meta.MARKER||o.service!=='SCCRMHQSalesImport'||o.sourceHash!==c.sourceHash())throw Error('SALES_INSTALLED_IDENTITY_REFUSED');return o;}
function query(sql){return c.sql(c.admin('000'),`IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesMeta WHERE marker='${c.meta.MARKER}' AND schema_hash='${c.s.hash}') RAISERROR('SALES_TARGET_REFUSED',16,1);`+sql);}
try{const action=process.argv[2];let result;
 if(action==='seal'||action==='seal-copy'){
  own();const identity=JSON.parse(fs.readFileSync(path.join(remote,'status/health.json')));if(identity.machine!=='SERVER'||identity.account!=='NT AUTHORITY\\LOCAL SERVICE'&&identity.account!=='NT AUTHORITY\\LocalService'||identity.session!==0||!['awaiting_credentials','stopped'].includes(identity.state))throw Error('SALES_SERVICE_BOOTSTRAP_REFUSED');
  const cfg=structuredClone(c.secrets()[action==='seal-copy'?'copyConfig':'liveConfig']);cfg.hq.server='tcp:127.0.0.1,49800';if(action==='seal-copy')for(const b of c.branches)cfg.sources[b].server='tcp:127.0.0.1,49800';const packet=c.seal(cfg,JSON.parse(fs.readFileSync(path.join(remote,'status/bootstrap-public.json'))));const temp=path.join(remote,'runtime/credentials.hybrid.json.new');fs.writeFileSync(temp,JSON.stringify(packet));fs.renameSync(temp,path.join(remote,'runtime/credentials.hybrid.json'));result={ok:true,sealed:true,mode:action==='seal-copy'?'copy':'live',adminRuntimeCredentials:false};
 }else if(action==='enable'){
  own();const proof=JSON.parse(fs.readFileSync(path.join(c.run,'copy-proof.json')));if(!proof.ok||proof.sourceHash!==c.sourceHash())throw Error('SALES_COPY_PROOF_REQUIRED');const target=process.argv[3];const branches=target==='all'?c.branches:target==='005'?['005']:null;if(!branches)throw Error('SALES_PILOT_FIRST_REQUIRED');if(target==='all'){const pilot=JSON.parse(fs.readFileSync(path.join(c.run,'pilot-proof.json')));if(!pilot.ok||pilot.sourceHash!==c.sourceHash()||pilot.branch!=='005')throw Error('SALES_PILOT_PROOF_REQUIRED');}
  query(`UPDATE dbo.SCCRM_SalesSources SET enabled=1 WHERE branch_code IN(${branches.map(b=>"'"+b+"'").join(',')});`);result={ok:true,enabled:branches};
 }else if(action==='status'){
  own();result={ok:true,health:JSON.parse(fs.readFileSync(path.join(remote,'status/health.json'))),sql:query("EXEC dbo.SCCRM_SalesQueue @Action='Status';SELECT TOP(20) j.branch_code,j.doc_no,j.state,j.last_code,j.attempts,e.outcome,e.inserted_rows,j.created_at,j.completed_at FROM dbo.SCCRM_SalesJobs j LEFT JOIN dbo.SCCRM_SalesJournal e ON e.job_id=j.id ORDER BY j.updated_at DESC;")};
 }else if(action==='reviews')result={ok:true,rows:query("SELECT branch_code,doc_no,state,last_code,attempts FROM dbo.SCCRM_SalesJobs WHERE state IN('review','retry') ORDER BY branch_code,doc_no;")};
 else throw Error('SALES_ACTION_REFUSED');console.log(JSON.stringify(result));
}catch(e){console.log(JSON.stringify({ok:false,code:e.message,proof:e.proof}));process.exitCode=1;}
