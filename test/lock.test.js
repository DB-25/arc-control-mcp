// The cross-process lock breaks a lock by the age of its file, never by how
// long the waiter has been waiting: a holder that is alive and working (for
// instance creating the agent window) must not lose its lock to an impatient
// waiter.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLock, withLockAsync } from '../src/state.js';

const dir = mkdtempSync(join(tmpdir(), 'arc-lock-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let n = 0;
const lockPath = () => join(dir, `l${++n}.lock`);
const HOUR_S = 3600;

describe('openLock', () => {
  it('takes a free lock', () => {
    const file = lockPath();
    const fd = openLock(file, 1000);
    assert.equal(typeof fd, 'number');
    closeSync(fd);
  });

  it('leaves a fresh lock alone, however long the caller has been waiting', () => {
    const file = lockPath();
    writeFileSync(file, '');
    assert.equal(openLock(file, 60000), null);
    assert.equal(existsSync(file), true);
  });

  it('breaks a lock whose file is older than the stale threshold', () => {
    const file = lockPath();
    writeFileSync(file, '');
    const old = Date.now() / 1000 - HOUR_S;
    utimesSync(file, old, old);
    const fd = openLock(file, 30000);
    assert.equal(typeof fd, 'number');
    closeSync(fd);
  });
});

describe('withLockAsync', () => {
  it('a waiter waits out a live holder instead of stealing the lock', async () => {
    const file = lockPath();
    const order = [];
    const holder = withLockAsync(file, async () => {
      order.push('holder in');
      await sleep(250);
      order.push('holder out');
    });
    await sleep(20);
    const waiter = withLockAsync(file, async () => {
      order.push('waiter in');
    }, 30000);
    await Promise.all([holder, waiter]);
    assert.deepEqual(order, ['holder in', 'holder out', 'waiter in']);
  });

  it('recovers at once from a lock a dead process left long ago', async () => {
    const file = lockPath();
    writeFileSync(file, '');
    const old = Date.now() / 1000 - HOUR_S;
    utimesSync(file, old, old);
    const started = Date.now();
    assert.equal(await withLockAsync(file, async () => 'ran', 30000), 'ran');
    assert.ok(Date.now() - started < 1000);
    assert.equal(existsSync(file), false);
  });

  it('releases the lock when the work throws', async () => {
    const file = lockPath();
    await assert.rejects(withLockAsync(file, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(file), false);
  });
});
