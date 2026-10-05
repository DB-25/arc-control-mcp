// The gate that keeps the server from opening windows or tabs, or moving focus,
// while the user is typing. The idle reader, sleep and clock are injected, so
// none of this spawns ioreg or waits in real time.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIdleMs,
  parseActivityConfig,
  createActivityGate,
  needsIdle,
  gateTool,
  withGate,
  GATED_TOOLS,
  DEFAULT_IDLE_MS,
  DEFAULT_IDLE_WAIT_MS,
  USER_ACTIVE_ERROR
} from '../src/user-activity.js';

const IOREG_SAMPLE = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000a1f, registered, matched, active, busy 0 (0 ms), retain 17>
    {
      "HIDParameters" = {"HIDClickTime"=500000000,"HIDKeyRepeat"=83333333}
      "HIDIdleTime" = 1500000000
      "IOClass" = "IOHIDSystem"
    }`;

/** A clock the fake sleep advances, plus a reader that follows a script of idle values. */
function world(readings) {
  const clock = { t: 0, reads: 0, sleeps: [] };
  const script = Array.isArray(readings) ? readings : null;
  return {
    clock,
    read: async () => {
      clock.reads += 1;
      if (script) return script[Math.min(clock.reads - 1, script.length - 1)];
      return readings(clock.t);
    },
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t
  };
}

describe('parseIdleMs', () => {
  it('converts the HIDIdleTime nanoseconds to milliseconds', () => {
    assert.equal(parseIdleMs(IOREG_SAMPLE), 1500);
    assert.equal(parseIdleMs('"HIDIdleTime" = 250000000'), 250);
    assert.equal(parseIdleMs('"HIDIdleTime" = 0'), 0);
  });

  it('copes with a 64-bit-sized reading', () => {
    assert.equal(parseIdleMs('"HIDIdleTime" = 8000000000000'), 8000000);
  });

  it('takes the most recent input when several entries are printed', () => {
    assert.equal(parseIdleMs('"HIDIdleTime" = 9000000000\n"HIDIdleTime" = 3000000'), 3);
  });

  it('returns null when there is no reading, rather than inventing one', () => {
    assert.equal(parseIdleMs(''), null);
    assert.equal(parseIdleMs('"HIDIdleTime" = abc'), null);
    assert.equal(parseIdleMs('"HIDParameters" = {}'), null);
  });
});

describe('parseActivityConfig', () => {
  it('defaults to 1500 ms idle and a 15 s wait', () => {
    const config = parseActivityConfig({});
    assert.equal(config.idleMs, DEFAULT_IDLE_MS);
    assert.equal(config.idleMs, 1500);
    assert.equal(config.waitMs, DEFAULT_IDLE_WAIT_MS);
    assert.equal(config.waitMs, 15000);
  });

  it('reads both variables, and 0 disables the gate', () => {
    assert.deepEqual(parseActivityConfig({ ARC_MCP_IDLE_MS: '0', ARC_MCP_IDLE_WAIT_MS: '500' }), {
      idleMs: 0,
      waitMs: 500,
      warnings: []
    });
  });

  it('falls back on nonsense and says so', () => {
    const config = parseActivityConfig({ ARC_MCP_IDLE_MS: 'soon', ARC_MCP_IDLE_WAIT_MS: '-5' });
    assert.equal(config.idleMs, 1500);
    assert.equal(config.waitMs, 15000);
    assert.equal(config.warnings.length, 2);
  });
});

describe('the wait', () => {
  it('passes at once when the user is already idle, without sleeping', async () => {
    const w = world([5000]);
    const gate = createActivityGate({ ...w, idleMs: 1500, waitMs: 15000 });
    const result = await gate.wait();
    assert.equal(result.ok, true);
    assert.equal(result.waitedForUserMs, 0);
    assert.deepEqual(w.clock.sleeps, []);
  });

  it('polls every 250 ms until the user has been idle long enough, and reports how long it waited', async () => {
    // Idle grows with the clock after one burst of typing at t=0.
    const w = world((t) => t);
    const gate = createActivityGate({ ...w, idleMs: 1500, waitMs: 15000 });
    const result = await gate.wait();
    assert.equal(result.ok, true);
    assert.equal(result.waitedForUserMs, 1500);
    assert.ok(w.clock.sleeps.every((ms) => ms === 250));
    assert.equal(w.clock.sleeps.length, 6);
  });

  it('restarts the count when the user types again mid-wait', async () => {
    const w = world([0, 250, 500, 0, 250, 500, 1000, 1500]);
    const gate = createActivityGate({ ...w, idleMs: 1500, waitMs: 15000 });
    const result = await gate.wait();
    assert.equal(result.ok, true);
    assert.equal(w.clock.reads, 8);
  });

  it('gives up after the wait budget with userActive true, and never loops on', async () => {
    const w = world([10]);
    const gate = createActivityGate({ ...w, idleMs: 1500, waitMs: 15000 });
    const result = await gate.wait();
    assert.equal(result.ok, false);
    assert.equal(result.userActive, true);
    assert.equal(result.waitedForUserMs, 15000);
    assert.equal(result.idleMs, 10);
    assert.ok(w.clock.reads < 100);
  });

  it('never sleeps past the budget', async () => {
    const w = world([10]);
    const gate = createActivityGate({ ...w, idleMs: 1500, waitMs: 600 });
    const result = await gate.wait();
    assert.equal(result.waitedForUserMs, 600);
    assert.ok(w.clock.sleeps.every((ms) => ms <= 250));
  });

  it('is off when ARC_MCP_IDLE_MS is 0: it does not even read the idle time', async () => {
    const w = world([0]);
    const gate = createActivityGate({ ...w, idleMs: 0, waitMs: 15000 });
    const result = await gate.wait();
    assert.deepEqual(result, { ok: true, disabled: true, waitedForUserMs: 0 });
    assert.equal(w.clock.reads, 0);
  });

  it('fails open, saying so, when the idle time cannot be read', async () => {
    const gate = createActivityGate({
      read: async () => {
        throw new Error('ioreg missing');
      },
      idleMs: 1500,
      waitMs: 15000
    });
    const result = await gate.wait();
    assert.equal(result.ok, true);
    assert.match(result.unverified, /ioreg missing/);
  });

  it('reports the current idle time for arc_status, and never throws', async () => {
    const ok = await createActivityGate({ read: async () => 1234.6, idleMs: 1500 }).status();
    assert.equal(ok.userIdleMs, 1235);
    assert.equal(ok.gate, 'on');
    const off = await createActivityGate({ read: async () => 1, idleMs: 0 }).status();
    assert.equal(off.gate, 'off');
    const broken = await createActivityGate({
      read: async () => {
        throw new Error('nope');
      }
    }).status();
    assert.equal(broken.userIdleMs, null);
    assert.equal(broken.error, 'nope');
  });
});

describe('which tools are gated', () => {
  it('gates the tools that change what is on screen or which window has focus', () => {
    assert.equal(needsIdle('switch_to_tab', { tab_id: 'x' }), true);
    assert.equal(needsIdle('focus_space', { space: 'Agent' }), true);
    assert.equal(needsIdle('open_url', { new_tab: true }), true);
    assert.equal(needsIdle('open_url', { new_tab: true, activate: true }), true);
    assert.equal(needsIdle('open_url', { little_arc: true, new_tab: true }), true);
    assert.equal(needsIdle('open_url', { new_tab: false, activate: true }), true);
  });

  it('does not gate navigating an existing tab in place', () => {
    assert.equal(needsIdle('open_url', { new_tab: false }), false);
    assert.equal(needsIdle('open_url', { new_tab: false, activate: false, little_arc: false }), false);
  });

  it('never gates reads, page scripting, history or closing', () => {
    for (const name of [
      'list_tabs', 'get_current_tab', 'arc_status', 'list_spaces', 'close_tab', 'close_own_tabs',
      'get_page_content', 'get_page_info', 'get_html', 'get_links', 'query_elements',
      'execute_javascript', 'click', 'fill', 'select_option', 'press_key', 'scroll',
      'wait_for_load', 'wait_for_selector', 'go_back', 'go_forward', 'reload_tab', 'batch'
    ]) {
      assert.equal(needsIdle(name, {}), false, `${name} must not be gated`);
    }
  });

  it('lists exactly three gated tools, so a new one is a deliberate choice', () => {
    assert.deepEqual(Object.keys(GATED_TOOLS).sort(), ['focus_space', 'open_url', 'switch_to_tab']);
  });
});

describe('gateTool and withGate', () => {
  const busy = { wait: async () => ({ ok: false, userActive: true, waitedForUserMs: 15000, idleMs: 40.4 }) };
  const quiet = (ms) => ({ wait: async () => ({ ok: true, waitedForUserMs: ms }) });

  it('turns a user who never paused into ok false with userActive and a retry message', async () => {
    const gate = await gateTool('switch_to_tab', { tab_id: 'x' }, busy);
    assert.equal(gate.proceed, false);
    assert.equal(gate.result.ok, false);
    assert.equal(gate.result.userActive, true);
    assert.equal(gate.result.error, USER_ACTIVE_ERROR);
    assert.match(gate.result.error, /using the Mac/);
    assert.match(gate.result.error, /Retry/);
    assert.equal(gate.result.waitedForUserMs, 15000);
    assert.equal(gate.result.userIdleMs, 40);
  });

  it('does not even ask about an ungated tool', async () => {
    const gate = await gateTool('get_page_content', {}, {
      wait: async () => {
        throw new Error('must not be consulted');
      }
    });
    assert.deepEqual(gate, { proceed: true });
  });

  it('puts waitedForUserMs on a successful result', async () => {
    const gate = await gateTool('open_url', { new_tab: true }, quiet(1200));
    assert.equal(gate.proceed, true);
    assert.deepEqual(withGate({ ok: true, tab: 1 }, gate), { ok: true, tab: 1, waitedForUserMs: 1200 });
  });

  it('adds to a wait the tool itself already reported', async () => {
    const gate = await gateTool('open_url', { new_tab: true }, quiet(100));
    assert.equal(withGate({ ok: true, waitedForUserMs: 50 }, gate).waitedForUserMs, 150);
  });

  it('adds nothing when the gate is disabled or the tool is not gated', async () => {
    const off = await gateTool('open_url', { new_tab: true }, { wait: async () => ({ ok: true, disabled: true, waitedForUserMs: 0 }) });
    assert.deepEqual(withGate({ ok: true }, off), { ok: true });
    assert.deepEqual(withGate({ ok: true }, { proceed: true }), { ok: true });
  });

  it('passes an unreadable idle time through as a note', async () => {
    const gate = await gateTool('focus_space', {}, { wait: async () => ({ ok: true, waitedForUserMs: 0, unverified: 'no ioreg' }) });
    assert.equal(withGate({ ok: true }, gate).userIdleCheck, 'no ioreg');
  });
});
