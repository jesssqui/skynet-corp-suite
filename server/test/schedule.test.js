import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBackupSchedule, RETRY_MS } from '../src/backup/schedule.js';

const quiet = { info() {}, warn() {}, error() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function advance(t, ms) {
  t.mock.timers.tick(ms);
  await flush();
  await flush();
}

test('a failed backup is retried (hourly by default) until one succeeds', async (t) => {
  assert.equal(RETRY_MS, 60 * 60 * 1000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const outcomes = [false, false, true]; // fail, fail, succeed
  let calls = 0;
  const stop = startBackupSchedule({
    time: '03:15',
    lastSuccessAt: null, // triggers the catch-up run
    catchUpDelayMs: 100,
    retryMs: 1000,
    log: quiet,
    run: async () => {
      const ok = outcomes[calls++];
      if (!ok) throw new Error('offsite not mounted');
    },
  });
  t.after(stop);

  await advance(t, 100);
  assert.equal(calls, 1, 'catch-up ran and failed');
  await advance(t, 999);
  assert.equal(calls, 1, 'no retry before retryMs');
  await advance(t, 1);
  assert.equal(calls, 2, 'first retry');
  await advance(t, 1000);
  assert.equal(calls, 3, 'second retry succeeded');
  await advance(t, 5000);
  assert.equal(calls, 3, 'no more retries after a success');
});

test('no retry is scheduled after a success, and stop cancels a pending retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startBackupSchedule({
    time: '03:15',
    lastSuccessAt: null,
    catchUpDelayMs: 10,
    retryMs: 1000,
    log: quiet,
    run: async () => {
      calls += 1;
      throw new Error('boom');
    },
  });
  await advance(t, 10);
  assert.equal(calls, 1);
  stop();
  await advance(t, 5000);
  assert.equal(calls, 1, 'stopped schedule does not retry');
});

test('no catch-up or retry when the last backup is recent and nothing failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startBackupSchedule({
    time: '03:15',
    lastSuccessAt: new Date().toISOString(),
    catchUpDelayMs: 10,
    retryMs: 1000,
    log: quiet,
    run: async () => { calls += 1; },
  });
  t.after(stop);
  await advance(t, 10_000);
  assert.equal(calls, 0);
});
