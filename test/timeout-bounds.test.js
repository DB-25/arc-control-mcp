// The P0 this round fixed. An MCP client abandons a request after 60s (the
// SDK's own default), and a call that outlives that loses its result: the caller
// sees RequestTimeout instead of the timedOut payload that says what the page
// was doing. open_url's worst case used to land exactly on 60000 (a 45000ms
// open budget plus a 15000ms load wait), and a caller-supplied timeout_ms had no
// ceiling at all, so wait_for_selector({ timeout_ms: 90000 }) could never
// answer: the client killed it at 60s, every time.
//
// The fix has two halves and both are checked here. The JSON Schema maximum is
// what stops a model asking for 90s in the first place; the Math.min at runtime
// is what stops it mattering when one asks anyway. The specific numbers will
// drift. An unbounded timeout_ms must not reappear.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS } from '../src/registry.js';
import { handlers as navigation } from '../src/tools/navigation.js';
import { handlers as interact } from '../src/tools/interact.js';
import { ArcError } from '../src/jxa.js';

// The MCP client default request timeout, which is the deadline everything here
// has to stay inside.
const CLIENT_DEADLINE_MS = 60000;
// The ceiling a caller is allowed to ask for. Well inside the deadline, so a
// tool's own launch budget still fits alongside the longest wait it can be given.
const MAX_CALLER_TIMEOUT_MS = 30000;
// navigation contributes four navigating tools plus wait_for_load, interact
// contributes wait_for_selector. Below that, the loop is checking nothing.
const MIN_TOOLS_WITH_TIMEOUT = 6;

const TOOLS_DIR = fileURLToPath(new URL('../src/tools/', import.meta.url));

// A tab id no Arc window can have. Belt and braces for the cancellation tests
// below: they must never reach Arc, and if the guard they test were broken, an
// explicit unreachable id fails loudly instead of resolving to whatever tab the
// user is looking at.
const UNREACHABLE_TAB = 'NOT-A-REAL-TAB-ID';

const timeoutProps = TOOLS.flatMap((tool) =>
  Object.entries(tool.inputSchema.properties)
    .filter(([name]) => name === 'timeout_ms')
    .map(([name, schema]) => ({ where: `${tool.name}.${name}`, schema }))
);

describe('every caller-supplied timeout declares a ceiling', () => {
  it('at least the tools that wait take a timeout_ms', () => {
    assert.ok(
      timeoutProps.length >= MIN_TOOLS_WITH_TIMEOUT,
      `only ${timeoutProps.length} tools declare timeout_ms, so the checks below cover almost nothing`
    );
  });

  for (const { where, schema } of timeoutProps) {
    it(`${where} is bounded, so no argument can outlive the client's deadline`, () => {
      assert.equal(schema.type, 'number', `${where} is not a number`);
      assert.equal(
        typeof schema.maximum,
        'number',
        `${where} declares no maximum, so a model can ask for 90000ms and the client will kill the call`
      );
      assert.ok(schema.maximum > 0, `${where} maximum is ${schema.maximum}`);
      assert.ok(
        schema.maximum <= MAX_CALLER_TIMEOUT_MS,
        `${where} allows ${schema.maximum}ms, above the ${MAX_CALLER_TIMEOUT_MS}ms ceiling`
      );
      assert.ok(
        schema.maximum < CLIENT_DEADLINE_MS,
        `${where} allows ${schema.maximum}ms, which the client abandons at ${CLIENT_DEADLINE_MS}ms`
      );
    });

    it(`${where} defaults inside its own ceiling`, () => {
      if (schema.default === undefined) return;
      assert.ok(
        schema.default <= schema.maximum,
        `${where} defaults to ${schema.default}ms but allows at most ${schema.maximum}ms`
      );
    });

    it(`${where} tells the model what the ceiling is`, () => {
      // A maximum a client silently enforces looks like a broken tool from the
      // model's side. The description is where it finds out why 90000 became 30000.
      assert.match(
        schema.description,
        new RegExp(String(schema.maximum)),
        `${where} never mentions its ${schema.maximum}ms ceiling, so a clamped wait looks like a bug`
      );
    });
  }
});

describe('the ceiling is enforced at runtime, not only in the schema', () => {
  // A schema maximum is advice: nothing obliges a client to enforce it, and the
  // SDK server does not validate arguments. So every read of args.timeout_ms
  // has to go through Math.min as well.
  it('no handler reads args.timeout_ms without clamping it', () => {
    const reads = [];
    for (const file of readdirSync(TOOLS_DIR).filter((name) => name.endsWith('.js'))) {
      const lines = readFileSync(join(TOOLS_DIR, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/args\??\.timeout_ms/.test(line)) return;
        reads.push({ at: `src/tools/${file}:${index + 1}`, line: line.trim(), clamped: line.includes('Math.min(') });
      });
    }

    assert.ok(reads.length >= 2, `only ${reads.length} handlers read args.timeout_ms, so this check found nothing to check`);
    for (const read of reads) {
      assert.ok(read.clamped, `${read.at} reads args.timeout_ms without a Math.min ceiling: ${read.line}`);
    }
  });
});

describe('a cancelled wait gives up before it spawns anything', () => {
  // The spec asks a receiver of notifications/cancelled to stop work and
  // release resources. Every poll here spawns an osascript process against the
  // user's real Arc, so a loop that ignores the signal keeps prodding their
  // browser for a result nobody will read.
  //
  // These need no Arc: the guard runs at the top of the loop, before the first
  // probe. That is also why they are safe to run by default. A tab id that
  // cannot resolve means a broken guard fails this test rather than reaching a
  // real tab.
  const cancelled = (error) => {
    assert.ok(error instanceof ArcError, `expected an ArcError, got ${error}`);
    assert.match(error.message, /Cancelled/, 'a cancelled wait must say it was cancelled');
    return true;
  };

  it('wait_for_selector stops on an already-aborted signal', async () => {
    await assert.rejects(
      () => interact.wait_for_selector(
        { tab_id: UNREACHABLE_TAB, selector: '#anything', timeout_ms: MAX_CALLER_TIMEOUT_MS },
        { signal: AbortSignal.abort() }
      ),
      cancelled
    );
  });

  it('wait_for_load stops on an already-aborted signal', async () => {
    await assert.rejects(
      () => navigation.wait_for_load(
        { tab_id: UNREACHABLE_TAB, timeout_ms: MAX_CALLER_TIMEOUT_MS },
        { signal: AbortSignal.abort() }
      ),
      cancelled
    );
  });

  it('returns immediately rather than burning the timeout it was given', async () => {
    // The regression this pins: an ignored signal would poll to the ceiling
    // before answering, so the elapsed time is the assertion.
    const started = Date.now();
    await assert.rejects(
      () => interact.wait_for_selector(
        { tab_id: UNREACHABLE_TAB, selector: '#anything', timeout_ms: MAX_CALLER_TIMEOUT_MS },
        { signal: AbortSignal.abort() }
      ),
      cancelled
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `a cancelled wait took ${elapsed}ms, so it did work before checking the signal`);
  });
});
