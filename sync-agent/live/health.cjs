'use strict';
// Codes only: database messages can contain source values or customer details.
function failureCode(error) {
 if (/^[0-9A-Z]{5}$/.test(error.code || '')) return 'PG_' + error.code;
 return /^[A-Z_]{5,80}$/.test(error.message || '') ? error.message : 'LIVE_CYCLE_FAILED';
}
function workerState(...lanes) {
 if (lanes.some(lane => lane?.state === 'retrying')) return 'retrying';
 return lanes[0]?.state || 'waiting-credentials';
}
module.exports = { failureCode, workerState };
