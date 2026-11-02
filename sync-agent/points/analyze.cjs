'use strict';
const fs=require('node:fs'),path=require('node:path');
const source=require('./export.cjs');
const {compareDatabases}=require('./model.cjs');
function analyze({mode='Live',branches=source.BRANCHES,runtimeDirectory=source.RUNTIME}={}){
 if(!['Live','Copy'].includes(mode)||!Array.isArray(branches)||!branches.length||branches.some(b=>!source.BRANCHES.includes(b)))throw Error('POINT_ANALYSIS_SCOPE_REFUSED');
 runtimeDirectory=source.privateRuntime(runtimeDirectory);
 const snapshots=branches.map(branch=>{
  const s=JSON.parse(fs.readFileSync(path.join(runtimeDirectory,`native-${mode.toLowerCase()}-${branch}.json`),'utf8'));
  if(s.scope!==source.SCOPE||s.branch!==branch||s.mode!==mode||source.validateSchema(s.schema)!==s.schemaHash||s.productionWrites!==0||s.pinRead!==false||s.payloadHash!==source.sha({identity:s.identity,schemaHash:s.schemaHash,customers:s.customers,points:s.points,balances:s.balances,sourceConsistency:s.sourceConsistency}))throw Error('POINT_ANALYSIS_SOURCE_FINGERPRINT_REFUSED');
  return s;
 });
 const report=compareDatabases(snapshots);
 report.sourcePayloadHashes=Object.fromEntries(snapshots.map(s=>[s.branch,s.payloadHash]));
 fs.writeFileSync(path.join(runtimeDirectory,`comparison-${mode.toLowerCase()}.json`),JSON.stringify(report,null,2),{mode:0o600});
 const result={ok:true,scope:report.scope,at:report.at,sameSchema:report.sameSchema,schemaHashes:report.schemaHashes,
  databases:report.databases.map(d=>({branch:d.branch,balances:d.balances.length,verified:d.verified,held:d.held,heldEvents:d.heldEvents,viewMismatches:d.viewMismatches,snapshotVerified:d.snapshotVerified,issues:d.issues.reduce((r,i)=>{r[i.code]=(r[i.code]||0)+1;return r;},{})})),
  openings:{codes:report.openings.codes,sharedCodes:report.openings.sharedCodes,conflictingCodes:report.openings.conflictingCodes,matchingCodes:report.openings.matchingCodes,matchingNonzeroCodes:report.openings.matchingNonzeroCodes,invalid:report.openings.invalid.length},
  events:{canonical:report.replicas.canonicalEvents,duplicateReplicas:report.replicas.duplicateReplicas,conflicts:report.replicas.conflictingEvents,invalid:report.replicas.invalid.length},
  homes:{codes:report.homes.codes,conflictingCodes:report.homes.conflictingCodes,blankCodes:report.homes.blankCodes,sourceUnavailableCodes:report.homes.sourceUnavailableCodes,verifiedSourceCodes:report.homes.verifiedSourceCodes,verifiedHomeCounts:report.homes.verifiedHomeCounts},
  globalOpeningSelected:false,aliasesMerged:false,reportHash:source.sha(report),productionWrites:0,pinRead:false};
 fs.writeFileSync(path.join(runtimeDirectory,`comparison-${mode.toLowerCase()}-summary.json`),JSON.stringify(result,null,2),{mode:0o600});return result;
}
if(require.main===module){try{console.log(JSON.stringify(analyze({mode:process.argv[2]||'Live'})));}catch(e){console.error(JSON.stringify({ok:false,code:source.safeCode(e),productionWrites:0,pinRead:false}));process.exitCode=1;}}
module.exports={analyze};
