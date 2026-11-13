'use strict';
const path = require('node:path'), { spawnSync } = require('node:child_process');
const { readAdmin } = require('../fanout/admin-source.cjs');
const { record } = require('../history/model.cjs');
// Operator bootstrap only, never the long-lived service's authentication path.
// The result contains private profile data: pipe it to the importer, do not log.
function readBranchCustomer(branch, receipt, deps = {}) {
 if (!['001','003','004','005'].includes(branch) || receipt.branchCode !== branch || !new RegExp('^AR' + branch + '-[0-9]{6}$').test(receipt.adaCode)) throw Error('BRANCH_PROFILE_SCOPE_REFUSED');
 let admin;
 try {
  admin = (deps.readAdmin || readAdmin)(branch);
  const result = (deps.spawnSync || spawnSync)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile','-NonInteractive','-File',path.join(__dirname,'Read-BranchCustomer.ps1')], {
   windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 65536,
   input: JSON.stringify({ scope: 'SCCRM-READ-BRANCH-HISTORY-PROFILE-V1', branch, receipt, admin }),
   env: { ...process.env, PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' }
  });
  let packet;
  try { packet = JSON.parse(String(result.stdout || '').trim().replace(/^\uFEFF/, '')); } catch { throw Error('BRANCH_PROFILE_READER_UNAVAILABLE'); }
  if (result.status !== 0 || !packet.ok) throw Error(/^BRANCH_PROFILE_[A-Z_]+$/.test(packet.code || '') ? packet.code : 'BRANCH_PROFILE_READ_FAILED');
  const h = packet.header, c = packet.customer;
  if (packet.branch !== branch || packet.nativeSourceId !== 'branch'+branch+'/AdaAcc' || packet.productionWrites !== 0 || packet.pinRead !== false ||
   c?.FTCstCode !== receipt.adaCode || c.FTBchCode !== branch || h?.FTCstCode !== receipt.adaCode || h.FTBchCode !== branch || h.FTPosCode !== receipt.posCode || h.FTShdDocNo !== receipt.receiptNo) throw Error('BRANCH_PROFILE_ACK_REFUSED');
  record('customers', c); record('receipts', h);
  return packet;
 } finally { if (admin) admin.password = ''; }
}
module.exports = { readBranchCustomer };
