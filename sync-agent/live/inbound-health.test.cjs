'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { failureCode, workerState } = require('./health.cjs');
test('a failed inbound lane cannot be hidden by a healthy outgoing member lane', () => {
 assert.equal(workerState({ state: 'healthy' }, { state: 'retrying' }), 'retrying');
 assert.equal(workerState({ state: 'retrying' }, { state: 'healthy' }), 'retrying');
 assert.equal(workerState({ state: 'healthy' }, { state: 'healthy' }), 'healthy');
});
test('SQLSTATE survives in health without database messages or personal values', () => {
 assert.equal(failureCode({ code: '42501', message: 'permission denied for sensitive fixture' }), 'PG_42501');
 assert.equal(failureCode({ message: 'SOURCE_TIMEOUT' }), 'SOURCE_TIMEOUT');
 assert.equal(failureCode({ message: 'private fixture value' }), 'LIVE_CYCLE_FAILED');
});
