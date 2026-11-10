'use strict';
// Explicit COPY-only acceptance. CopyLab pins the database and NO REVERT
// database-only executor. Every DDL and synthetic customer rolls back.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { run } = require('../fanout/copy-lab.cjs');
const { profileHash } = require('../fanout/engine.cjs');
const { assignmentHash } = require('../member-codes/assignment.cjs');
const root = path.join(__dirname, '../member-codes');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const literal = value => value === null ? 'NULL' : "N'" + String(value).replaceAll("'", "''") + "'";
const execute = text => 'EXEC(' + literal(text.replace(/CREATE PROCEDURE/g, 'ALTER PROCEDURE')) + ');';
let stage='facts';
const query = async (branch, sql, parameters = {}) => (await run('Query', branch, { sql, parameters })).results;
const results = [], check = (name, condition) => { assert.ok(condition, name); results.push(name); };
function tableSnapshot(columns) {
  const projection = columns.map(row => '[' + row.name + ']').join(',');
  const exact = columns.map(row => 'CONVERT(varbinary(max),[' + row.name + '])').join(',');
  return { before: `SELECT ${projection} INTO #OriginalCustomers FROM dbo.TCNMCst;`,
    unchanged: `CASE WHEN EXISTS(SELECT ${exact} FROM #OriginalCustomers EXCEPT SELECT ${exact} FROM dbo.TCNMCst) THEN 0 ELSE 1 END` };
}
async function facts(branch) {
  const sets = await query(branch, `SELECT hq_identity,target_identity,creator_login,runtime_login,authority_login FROM dbo.SCCRM_MemberCodeScope;
    SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id;
    SELECT DISTINCT FTCstTel phone FROM dbo.TCNMCst WHERE LEN(FTCstTel)=10 AND LEFT(FTCstTel,2) IN('06','08','09') AND FTCstTel NOT LIKE '%[^0-9]%'`);
  assert.equal(sets[0].length, 1); assert.equal(sets[1].length, 101);
  assert.ok(sets[1].every(row => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.name)));
  return { ...sets[0][0], columns: sets[1], phones: sets[2].map(row => row.phone) };
}
async function main() {
  const hq = await facts('000'), branch = await facts('005');
  const phone = hq.phones.find(value => branch.phones.includes(value));
  assert.ok(phone, 'copy databases must contain a shared existing Thai mobile');
  const memberId = crypto.randomUUID(), requestId = crypto.randomUUID();
  const name = 'COPY shared-contact ' + memberId.slice(0, 8), email = '';
  const hqTemplate = read('Hq.sql').split(/^GO\s*$/m)[0].replaceAll('__HQ_IDENTITY__', hq.hq_identity);
  const snapshot = tableSnapshot(hq.columns);
  const setupHq = `BEGIN TRAN;${read('RegistrationSchemaUpgrade.sql')}${execute(hqTemplate)}`;
  stage='HQ-positive';
  const createdSets = await query('000', `${setupHq}${snapshot.before}
    EXECUTE AS USER=${literal(hq.creator_login)};
    SELECT HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','INSERT') direct_insert,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE') direct_update;
    EXEC dbo.SCCRM_CreateMemberFromSccrmV2 @MemberId=@member,@Name=@name,@Phone=@phone,@Email='',@DistinctRequest=@request;
    EXEC dbo.SCCRM_CreateMemberFromSccrmV2 @MemberId=@member,@Name=@name,@Phone=@phone,@Email='',@DistinctRequest=@request;
    REVERT;
    SELECT ${snapshot.unchanged} unchanged,(SELECT COUNT(*) FROM dbo.TCNMCst)-(SELECT COUNT(*) FROM #OriginalCustomers) added;
    ROLLBACK;`, { member: memberId, name, phone, request: requestId });
  check('HQ creator still has no direct native customer INSERT/UPDATE', createdSets[0][0].direct_insert === 0 && createdSets[0][0].direct_update === 0);
  const created = createdSets[1][0], repeated = createdSets[2][0];
  check('confirmed same-phone person receives a new AR code', created.outcome === 'created' && created.assignment_kind === 'hq_create_distinct' && /^AR000-[0-9]{6}$/.test(created.ada_code));
  check('lost acknowledgement replays the same member and AR code', repeated.outcome === 'existing' && created.member_id === repeated.member_id && created.ada_code === repeated.ada_code);
  check('HQ original 101-column customers preserved; exactly one new row before rollback', createdSets[3][0].unchanged === 1 && createdSets[3][0].added === 1);
  stage='HQ-unconfirmed-guard';
  const refused = await query('000', `${setupHq}DECLARE @error nvarchar(4000);EXECUTE AS USER=${literal(hq.creator_login)};
    BEGIN TRY EXEC dbo.SCCRM_CreateMemberFromSccrmV2 @MemberId=@member,@Name=@name,@Phone=@phone,@Email=''; END TRY BEGIN CATCH SET @error=ERROR_MESSAGE();END CATCH;
    REVERT;IF @@TRANCOUNT>0 ROLLBACK;SELECT @error code;`, { member: crypto.randomUUID(), name, phone });
  check('ordinary unconfirmed same-phone request is still refused', refused.at(-1)[0].code === 'MEMBER_CODES_EXISTING_CUSTOMER_REVIEW');
  const profile = { name, phone, email }, digest = profileHash(profile);
  const assignment = { version: 1, assignmentId: created.assignment_id, memberId, adaCode: created.ada_code,
    hqIdentity: hq.hq_identity, profileHash: digest, assignedAt: created.assigned_at, kind: 'hq_create_distinct' };
  const auditHash = assignmentHash(assignment, { expectedHqIdentity: hq.hq_identity });
  const branchSql = read('Target.sql').replaceAll('__HQ_IDENTITY__', hq.hq_identity).replaceAll('__TARGET_IDENTITY__', branch.target_identity);
  const setupBranch = 'BEGIN TRAN;' + branchSql.split(/^GO\s*$/m).filter(text => text.trim()).map(execute).join('\n');
  const bSnapshot = tableSnapshot(branch.columns);
  const parameters = { assignment: created.assignment_id, member: memberId, code: created.ada_code, name, phone,
    profile: digest, audit: auditHash, hq: hq.hq_identity, target: branch.target_identity, assignedAt: created.assigned_at };
  const approve = `EXECUTE AS USER=${literal(branch.authority_login)};
    EXEC dbo.SCCRM_ApproveMemberCodeAssignment @AssignmentId=@assignment,@MemberId=@member,@HqCode=@code,@PreviousCode=NULL,@Kind='hq_create_distinct',
      @Name=@name,@Phone=@phone,@Email='',@ProfileHash=@profile,@AssignmentHash=@audit,@HqIdentity=@hq,@TargetIdentity=@target,@AssignedAt=@assignedAt;REVERT;`;
  const receive = `EXEC dbo.SCCRM_ReceiveAssignedMember @AssignmentId=@assignment,@MemberId=@member,@HqCode=@code,
      @Name=@name,@Phone=@phone,@Email='',@ProfileHash=@profile,@TargetIdentity=@target;`;
  stage='005-positive';
  const receivedSets = await query('005', `${setupBranch}${bSnapshot.before}${approve}
    EXECUTE AS USER=${literal(branch.runtime_login)};${receive}${receive}REVERT;
    SELECT ${bSnapshot.unchanged} unchanged,(SELECT COUNT(*) FROM dbo.TCNMCst)-(SELECT COUNT(*) FROM #OriginalCustomers) added;
    ROLLBACK;`, parameters);
  const received = receivedSets.find(set => set[0]?.outcome === 'created')?.[0];
  const replay = receivedSets.find(set => set[0]?.outcome === 'existing')?.[0];
  check('005 inserts the separately approved person despite an existing same phone', received?.ada_code === created.ada_code && received.member_id === memberId);
  check('005 replay never duplicates or changes ownership', replay?.ada_code === created.ada_code && replay.member_id === memberId);
  check('005 card validity passes the native search SQL condition', received.native_lookup_eligible === 1);
  check('005 original 101-column customers preserved; exactly one new row before rollback', receivedSets.at(-1)[0].unchanged === 1 && receivedSets.at(-1)[0].added === 1);
  for (const b of ['000', '005']) {
    const after = await query(b, 'SELECT COUNT(*) n FROM dbo.TCNMCst WHERE FTCstCode=@code;', { code: created.ada_code });
    check(b + ' copy synthetic member was rolled back', after[0][0].n === 0);
  }
  const report = { ok: true, scope: 'SCCRM-REGISTRATION-NATIVE-COPY-ONLY', at: new Date().toISOString(),
    passed: results.length, checks: results, productionWrites: 0, customerPinRead: false, allCopyChangesRolledBack: true };
  const output = path.join(__dirname, '../../build-verify/registration-native-copy-result.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(JSON.stringify({ ok: false, stage, code: error.code || error.message,
  sqlNumber:error.result?.sqlNumber,copyStage:error.result?.stage,productionWrites: 0 })); process.exitCode = 1; });
