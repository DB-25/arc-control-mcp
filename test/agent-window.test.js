// The dedicated agent window, against a fake Arc and a fake Accessibility
// driver. Nothing here starts osascript, so nothing can touch a real window.
// The invariant under test is that there is never more than one agent window:
// Arc ignores Close Window unless it is frontmost, so an extra one could not be
// cleaned up afterwards.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentWindowManager, LIST_SCRIPT, CREATE_SCRIPT } from '../src/agent-window.js';
import { PREAMBLE } from '../src/jxa.js';
import { OPEN_TAB_SCRIPT } from '../src/tools/open-dedicated.js';
import { AxPermissionError, AxError, ACCESSIBILITY_NOTE } from '../src/ax.js';
import { UserActiveError, userActiveResult } from '../src/user-activity.js';

const temps = [];
const freshDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-window-'));
  temps.push(dir);
  return dir;
};
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const MAIN = { frame: { x: 0, y: 0, width: 2560, height: 1440 }, visibleFrame: { x: 0, y: 0, width: 2560, height: 1415 } };
const PORTRAIT = { frame: { x: -1080, y: -382, width: 1080, height: 1920 }, visibleFrame: { x: -1080, y: -382, width: 1080, height: 1895 } };
const idle = async () => ({ ok: true, waitedForUserMs: 0 });
const ARC_APP = { name: 'Arc', bundleId: 'company.thebrowser.Browser' };
const TERMINAL = { name: 'Terminal', bundleId: 'com.apple.Terminal' };

/** One Arc, shared by every manager that stands for a process. */
function fakeWorld({ accessibility = true, screens = [MAIN, PORTRAIT], windows = [], arcRunning = true, frontApp = ARC_APP } = {}) {
  const world = {
    windows, // { id, visible, minimized, closed }
    events: [],
    created: 0,
    focusedId: 'user-window',
    accessibility,
    arcRunning,
    frontApp, // the application the user is in; Arc takes it when it launches or makes a window
    state: { x: 100, y: 100, width: 1100, height: 800 },
    // Frames of the user's own windows, as Accessibility reports them.
    userFrames: { 'user-window': { x: 1280, y: 31, width: 1281, height: 1410, minimized: false } },
    // Reproduces 5 Oct 2026: the user's window jumped to the agent window's spot.
    moveUserOnCreate: false
  };
  const denied = () => {
    // System Events has no "Arc" process until Arc runs, which is not a permission problem.
    if (!world.arcRunning) throw new AxError('System Events got an error: Can\u2019t get process "Arc". (-1728)');
    if (!world.accessibility) throw new AxPermissionError(ACCESSIBILITY_NOTE);
  };
  world.arc = {
    list: async (options) => {
      world.events.push(options?.launch === false ? 'list-nolaunch' : 'list');
      if (options?.launch !== false && !world.arcRunning) {
        world.arcRunning = true; // the real script launches Arc, which comes to the front
        world.frontApp = ARC_APP;
        world.events.push('launch');
      }
      return world.windows.map((w) => ({ id: w.id, visible: w.visible && !w.minimized && !w.closed }));
    },
    create: async () => {
      await tick();
      world.created += 1;
      const id = `agent-${world.created}`;
      world.windows.push({ id, visible: true, minimized: false, closed: false });
      world.events.push('create');
      if (world.moveUserOnCreate) world.userFrames['user-window'] = { ...world.userFrames['user-window'], x: -1080, y: 157 };
      world.focusedId = id; // Arc raises what it makes
      world.frontApp = ARC_APP; // and comes to the front to do it
      return id;
    }
  };
  world.ax = {
    windowIds: async () => {
      denied();
      return world.windows.filter((w) => !w.closed).map((w) => w.id);
    },
    focus: async () => {
      denied();
      return { frontmost: world.frontApp === ARC_APP, focusedId: world.focusedId };
    },
    frontApp: async () => world.frontApp,
    activateApp: async (app) => {
      world.events.push(`activate:${app.name}`);
      if (!world.activationIgnored) world.frontApp = app;
    },
    state: async (id) => {
      denied();
      const w = world.windows.find((x) => x.id === id);
      return { ...world.state, minimized: Boolean(w?.minimized) };
    },
    raise: async (id) => {
      denied();
      world.events.push(`raise:${id}`);
      world.focusedId = id;
    },
    frames: async () => {
      denied();
      return Object.entries(world.userFrames).map(([id, f]) => ({ id, ...f }));
    },
    place: async (id, rect) => {
      denied();
      if (world.userFrames[id]) {
        world.events.push(`moveback:${id}`);
        world.userFrames[id] = { ...world.userFrames[id], x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        return;
      }
      world.events.push('place');
      world.placed = { id, rect };
    },
    setMinimized: async (id, minimized) => {
      denied();
      world.events.push(`minimize:${minimized}`);
      world.windows.find((w) => w.id === id).minimized = minimized;
    }
  };
  world.screens = async () => screens;
  return world;
}

function manager(world, dir, overrides = {}) {
  return createAgentWindowManager({
    dir,
    arc: world.arc,
    ax: world.ax,
    screens: world.screens,
    config: { mode: 'dedicated', placement: 'auto', warnings: [] },
    gate: idle,
    ...overrides
  });
}

const noop = async () => 'ran';

describe('one agent window, ever', () => {
  it('concurrent find-or-create calls in one process create exactly one window', async () => {
    const world = fakeWorld();
    const mgr = manager(world, freshDir());
    const results = await Promise.all(Array.from({ length: 6 }, () => mgr.withWindow(noop)));
    assert.equal(world.created, 1);
    assert.equal(new Set(results.map((r) => r.window.id)).size, 1);
  });

  it('concurrent calls from several processes sharing a state dir create exactly one window', async () => {
    const world = fakeWorld();
    const dir = freshDir();
    const managers = [manager(world, dir), manager(world, dir), manager(world, dir)];
    const results = await Promise.all(managers.flatMap((mgr) => [mgr.withWindow(noop), mgr.withWindow(noop)]));
    assert.equal(world.created, 1);
    assert.equal(new Set(results.map((r) => r.window.id)).size, 1);
    assert.equal(results.filter((r) => r.window.created).length, 1);
  });

  it('persists the id in the state dir so a restarted server reuses the window', async () => {
    const world = fakeWorld();
    const dir = freshDir();
    await manager(world, dir).withWindow(noop);
    assert.equal(JSON.parse(readFileSync(join(dir, 'agent-window.json'), 'utf8')).windowId, 'agent-1');
    const again = await manager(world, dir).withWindow(noop);
    assert.equal(again.window.created, false);
    assert.equal(world.created, 1);
  });

  it('never creates one for a minimized window, which Arc reports as visible=false', async () => {
    const world = fakeWorld();
    const dir = freshDir();
    const mgr = manager(world, dir);
    await mgr.withWindow(noop);
    world.windows[0].minimized = true;
    await mgr.withWindow(noop);
    assert.equal(world.created, 1);
  });

  it('creates a new one when the persisted window is closed, which Accessibility no longer lists', async () => {
    const world = fakeWorld();
    const dir = freshDir();
    const mgr = manager(world, dir);
    await mgr.withWindow(noop);
    world.windows[0].closed = true; // a phantom: still in Arc's list, visible=false
    const second = await mgr.withWindow(noop);
    assert.equal(world.created, 2);
    assert.equal(second.window.id, 'agent-2');
    assert.equal(mgr.currentId(), 'agent-2');
  });

  it('creates one when Arc no longer lists the persisted id at all, even without Accessibility', async () => {
    const world = fakeWorld({ accessibility: false });
    const dir = freshDir();
    const mgr = manager(world, dir);
    await mgr.withWindow(noop);
    world.windows.length = 0;
    await mgr.withWindow(noop);
    assert.equal(world.created, 2);
  });

  it('without Accessibility, invisible and still listed is assumed minimized, and a failure on use says so', async () => {
    const world = fakeWorld({ accessibility: false });
    const dir = freshDir();
    const mgr = manager(world, dir);
    await mgr.withWindow(noop);
    world.windows[0].minimized = true;
    await assert.rejects(
      mgr.withWindow(async () => {
        throw new Error('tab push failed');
      }),
      /tab push failed.*may have been closed.*Accessibility/s
    );
    assert.equal(world.created, 1);
  });

  it('does not create a window when the creation call reports none', async () => {
    const world = fakeWorld();
    world.arc.create = async () => null;
    await assert.rejects(manager(world, freshDir()).withWindow(noop), /did not report a new window/);
  });

  it('leaves no lock file behind', async () => {
    const world = fakeWorld();
    const dir = freshDir();
    await manager(world, dir).withWindow(noop);
    assert.equal(existsSync(join(dir, 'agent-window.lock')), false);
  });
});

describe('placement', () => {
  it('auto puts the window on the largest non-main display, once', async () => {
    const world = fakeWorld();
    const mgr = manager(world, freshDir());
    const first = await mgr.withWindow(noop);
    assert.equal(first.window.placement, 'second-display');
    assert.ok(world.placed.rect.x >= -1080 && world.placed.rect.x + world.placed.rect.width <= 0);
    world.events.length = 0;
    await mgr.withWindow(noop);
    assert.ok(!world.events.includes('place'), 'a placed window is not moved again');
  });

  it('auto with a single display leaves the window where Arc put it', async () => {
    const world = fakeWorld({ screens: [MAIN] });
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.equal(result.window.placement, 'none');
    assert.ok(!world.events.includes('place'));
    assert.ok(!world.events.some((e) => e.startsWith('minimize')));
  });

  it('minimized only minimizes when asked, and re-minimizes if making a tab brought it back', async () => {
    const world = fakeWorld();
    const mgr = manager(world, freshDir(), { config: { mode: 'dedicated', placement: 'minimized', warnings: [] } });
    const result = await mgr.withWindow(async () => {
      world.windows[0].minimized = false; // what un-minimizing on tab creation would look like
    });
    assert.equal(result.window.placement, 'minimized');
    assert.equal(world.windows[0].minimized, true);
  });

  it('none never touches Accessibility for placement', async () => {
    const world = fakeWorld({ accessibility: false });
    const mgr = manager(world, freshDir(), { config: { mode: 'dedicated', placement: 'none', warnings: [] } });
    const result = await mgr.withWindow(noop);
    assert.equal(result.window.placement, 'none');
  });

  it('applies a placement skipped for lack of Accessibility once it is granted, then stops', async () => {
    const world = fakeWorld({ accessibility: false });
    let clock = 0;
    const mgr = manager(world, freshDir(), { now: () => clock });
    const first = await mgr.withWindow(noop);
    assert.equal(first.window.placement, null);
    world.accessibility = true;
    clock += 120000; // past the recheck interval
    const second = await mgr.withWindow(noop);
    assert.equal(second.window.placement, 'second-display');
  });
});

describe('Accessibility is optional', () => {
  it('does no placement and no restore without it, and gives the grant note exactly once', async () => {
    const world = fakeWorld({ accessibility: false });
    const mgr = manager(world, freshDir());
    const first = await mgr.withWindow(noop);
    assert.equal(first.focusRestored, false);
    assert.match(first.accessibilityNote, /System Settings > Privacy & Security > Accessibility/);
    assert.ok(!world.events.includes('place'));
    assert.ok(!world.events.some((e) => e.startsWith('raise')));
    const second = await mgr.withWindow(noop);
    assert.equal(second.accessibilityNote, undefined);
  });

  it('reports the same note when Accessibility is revoked mid-run', async () => {
    const world = fakeWorld();
    const mgr = manager(world, freshDir());
    await mgr.withWindow(noop);
    const result = await mgr.withWindow(async () => {
      world.accessibility = false;
    });
    assert.equal(result.focusRestored, false);
    assert.match(result.accessibilityNote, /Accessibility/);
  });
});

describe('focus protection', () => {
  it('puts the user\'s window back when making the window or tab raised another', async () => {
    const world = fakeWorld();
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.equal(result.focusRestored, true);
    assert.equal(world.focusedId, 'user-window');
    assert.ok(world.events.includes('raise:user-window'));
  });

  it('does nothing when focus did not move', async () => {
    const world = fakeWorld();
    const mgr = manager(world, freshDir());
    await mgr.withWindow(noop);
    world.events.length = 0;
    world.focusedId = 'user-window';
    const result = await mgr.withWindow(noop);
    assert.equal(result.focusRestored, false);
    assert.ok(!world.events.some((e) => e.startsWith('raise')));
  });

  it('is skipped when the caller asked to bring the window forward', async () => {
    const world = fakeWorld();
    const result = await manager(world, freshDir()).withWindow(noop, { restoreFocus: false });
    assert.equal(result.focusRestored, false);
    assert.ok(!world.events.some((e) => e.startsWith('raise')));
  });

  it('restores even when the work fails, then rethrows', async () => {
    const world = fakeWorld();
    const mgr = manager(world, freshDir());
    await assert.rejects(
      mgr.withWindow(async () => {
        world.focusedId = 'agent-1';
        throw new Error('boom');
      }),
      /boom/
    );
    assert.equal(world.focusedId, 'user-window');
  });
});

describe('cold start: Arc is not running', () => {
  it('launches Arc and makes the window instead of failing on System Events having no Arc process', async () => {
    const world = fakeWorld({ arcRunning: false, frontApp: TERMINAL });
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.equal(result.window.created, true);
    assert.equal(world.created, 1);
    assert.ok(world.events.includes('launch'));
  });

  it('does not cache the miss: Accessibility is used as soon as Arc is up', async () => {
    const world = fakeWorld({ arcRunning: false });
    const mgr = manager(world, freshDir());
    assert.equal(await mgr.accessibility(), false);
    world.arcRunning = true;
    assert.equal(await mgr.accessibility(), true, 'asked again, with no recheck interval to wait out');
  });

  it('says nothing about a missing grant, since none was refused', async () => {
    const world = fakeWorld({ arcRunning: false });
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.equal(result.accessibilityNote, undefined);
  });

  it('a permission refusal is still cached and reported', async () => {
    const world = fakeWorld({ accessibility: false });
    const mgr = manager(world, freshDir());
    const first = await mgr.withWindow(noop);
    assert.match(first.accessibilityNote, /Accessibility/);
  });

  it('arc_status does not throw, and does not blame a permission, while Arc is not running', async () => {
    const world = fakeWorld({ arcRunning: false });
    const mgr = manager(world, freshDir());
    const status = await mgr.status();
    assert.equal(status.accessibility.available, false);
    assert.equal(status.accessibility.unknown, true);
    assert.doesNotMatch(status.accessibility.note, /Privacy & Security/);
    assert.equal(world.arcRunning, false, 'looking must not launch Arc');
  });

  it('puts the application the user was in back in front after the launch took it', async () => {
    const world = fakeWorld({ arcRunning: false, frontApp: TERMINAL });
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.equal(result.focusRestored, true);
    assert.deepEqual(world.frontApp, TERMINAL);
    assert.ok(world.events.includes('activate:Terminal'));
  });
});

describe('restoring the user\'s application, not just their Arc window', () => {
  it('reactivates the previous app when making the window took the front, and reports it', async () => {
    const world = fakeWorld({ frontApp: TERMINAL });
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.equal(result.focusRestored, true);
    assert.deepEqual(world.frontApp, TERMINAL);
    assert.equal(result.focusRestoreError, undefined);
  });

  it('does nothing when the user was in Arc already', async () => {
    const world = fakeWorld({ frontApp: ARC_APP });
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.ok(!world.events.some((e) => e.startsWith('activate')));
    assert.equal(result.focusRestored, true, 'their Arc window was still put back');
  });

  it('does nothing and reports false when Arc never came to the front', async () => {
    const world = fakeWorld({ frontApp: TERMINAL });
    const mgr = manager(world, freshDir());
    await mgr.withWindow(noop);
    world.events.length = 0;
    world.focusedId = 'user-window';
    world.frontApp = TERMINAL;
    const result = await mgr.withWindow(noop);
    assert.equal(result.focusRestored, false);
    assert.ok(!world.events.some((e) => e.startsWith('activate') || e.startsWith('raise')));
  });

  it('a tab made in the existing window that activates Arc is undone too', async () => {
    const world = fakeWorld({ frontApp: TERMINAL });
    const mgr = manager(world, freshDir());
    await mgr.withWindow(noop);
    world.events.length = 0;
    world.frontApp = TERMINAL;
    const result = await mgr.withWindow(async () => {
      world.frontApp = ARC_APP;
    });
    assert.equal(result.focusRestored, true);
    assert.deepEqual(world.frontApp, TERMINAL);
  });

  it('says so instead of claiming success when the activation did not stick', async () => {
    const world = fakeWorld({ frontApp: TERMINAL });
    world.activationIgnored = true;
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.equal(result.focusRestored, false);
    assert.match(result.focusRestoreError, /Terminal.*not frontmost/);
  });

  it('is left alone when the caller asked to bring Arc forward', async () => {
    const world = fakeWorld({ frontApp: TERMINAL });
    const result = await manager(world, freshDir()).withWindow(noop, { restoreFocus: false });
    assert.equal(result.focusRestored, false);
    assert.deepEqual(world.frontApp, ARC_APP);
    assert.ok(!world.events.some((e) => e.startsWith('activate')));
  });

  it('is skipped with an error when the user got busy, rather than stealing the front back mid-keystroke', async () => {
    const world = fakeWorld({ frontApp: TERMINAL });
    let worked = false;
    const gate = async () => (worked ? { ok: false, userActive: true, waitedForUserMs: 15000 } : { ok: true, waitedForUserMs: 0 });
    const result = await manager(world, freshDir(), { gate }).withWindow(async () => {
      worked = true;
    });
    assert.equal(result.focusRestored, false);
    assert.match(result.focusRestoreError, /busy/);
    assert.deepEqual(world.frontApp, ARC_APP);
  });

  it('a failing frontApp read never fails the work', async () => {
    const world = fakeWorld({ frontApp: TERMINAL });
    world.ax.frontApp = async () => { throw new AxError('boom'); };
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.equal(result.window.created, true);
    assert.equal(result.focusRestored, true, 'the Arc window was still restored');
  });

  it('protectFocus restores around work that does not need the agent window', async () => {
    const world = fakeWorld({ frontApp: TERMINAL });
    const mgr = manager(world, freshDir());
    const done = await mgr.protectFocus(async () => {
      world.frontApp = ARC_APP;
      return 'shot';
    });
    assert.equal(done.value, 'shot');
    assert.equal(done.focusRestored, true);
    assert.deepEqual(world.frontApp, TERMINAL);
    assert.equal(world.created, 0, 'no window is made for it');
  });

  it('protectFocus restores even when the work fails, then rethrows', async () => {
    const world = fakeWorld({ frontApp: TERMINAL });
    await assert.rejects(
      manager(world, freshDir()).protectFocus(async () => {
        world.frontApp = ARC_APP;
        throw new Error('capture failed');
      }),
      /capture failed/
    );
    assert.deepEqual(world.frontApp, TERMINAL);
  });
});

describe('the user becoming active after the window was already created', () => {
  /** Quiet for the first `quiet` checks, busy afterwards. */
  const busyAfter = (quiet) => {
    let calls = 0;
    return async () => (++calls <= quiet ? { ok: true, waitedForUserMs: 0 } : { ok: false, userActive: true, waitedForUserMs: 15000, idleMs: 30 });
  };

  it('reports the created window and does not claim nothing was touched', async () => {
    const world = fakeWorld();
    // Gates: start, before the lock, then the one before placement fails.
    const mgr = manager(world, freshDir(), { gate: busyAfter(2) });
    const error = await mgr.withWindow(noop).catch((e) => e);
    assert.ok(error instanceof UserActiveError);
    assert.equal(world.created, 1);
    assert.deepEqual(error.agentWindow, { created: true, id: 'agent-1' });
    assert.doesNotMatch(error.message, /nothing was opened/);
    assert.match(error.message, /agent-1/);
    const result = userActiveResult(error.gate, error.agentWindow);
    assert.deepEqual(result.agentWindow, { created: true, id: 'agent-1' });
    assert.equal(result.userActive, true);
    assert.match(result.error, /already been created/);
  });

  it('the next call reuses and places that window instead of making another', async () => {
    const world = fakeWorld();
    const dir = freshDir();
    await manager(world, dir, { gate: busyAfter(2) }).withWindow(noop).catch(() => {});
    const result = await manager(world, dir).withWindow(noop);
    assert.equal(world.created, 1);
    assert.equal(result.window.created, false);
    assert.equal(result.window.placement, 'second-display');
  });

  it('a user who is busy before anything exists still gets the plain message and no agentWindow', async () => {
    const world = fakeWorld();
    const error = await manager(world, freshDir(), { gate: busyAfter(0) }).withWindow(noop).catch((e) => e);
    assert.ok(error instanceof UserActiveError);
    assert.equal(error.agentWindow, null);
    assert.match(error.message, /nothing was opened/);
    assert.equal(userActiveResult(error.gate, error.agentWindow).agentWindow, undefined);
    assert.equal(world.created, 0);
  });

  it('a busy user after an existing window was merely adopted is not reported as a creation', async () => {
    const world = fakeWorld();
    const dir = freshDir();
    await manager(world, dir).withWindow(noop);
    // Start gate passes, the one after ensure fails.
    const error = await manager(world, dir, { gate: busyAfter(1) }).withWindow(noop).catch((e) => e);
    assert.ok(error instanceof UserActiveError);
    assert.equal(error.agentWindow, null);
  });
});

describe('waiting for the user happens outside the lock', () => {
  it('never consults the activity gate while the lock file exists', async () => {
    const world = fakeWorld();
    const dir = freshDir();
    const seen = [];
    const gate = async () => {
      seen.push(existsSync(join(dir, 'agent-window.lock')));
      return { ok: true, waitedForUserMs: 0 };
    };
    await manager(world, dir, { gate }).withWindow(noop);
    assert.ok(seen.length >= 3);
    assert.ok(seen.every((held) => held === false), `gate ran under the lock: ${seen}`);
  });

  it('waits for idle before taking the lock', async () => {
    const world = fakeWorld();
    const dir = freshDir();
    const order = [];
    const gate = async () => {
      order.push('gate');
      return { ok: true, waitedForUserMs: 0 };
    };
    const real = world.arc.create;
    world.arc.create = async (...args) => {
      order.push(existsSync(join(dir, 'agent-window.lock')) ? 'create-under-lock' : 'create-unlocked');
      return real(...args);
    };
    await manager(world, dir, { gate }).withWindow(noop);
    assert.ok(order.indexOf('gate') < order.indexOf('create-under-lock'));
  });
});

describe('the user-activity gate inside window work', () => {
  it('refuses before creating anything when the user never pauses', async () => {
    const world = fakeWorld();
    const busy = async () => ({ ok: false, userActive: true, waitedForUserMs: 15000, idleMs: 20 });
    const mgr = manager(world, freshDir(), { gate: busy });
    await assert.rejects(mgr.withWindow(noop), (error) => error instanceof UserActiveError && error.gate.userActive);
    assert.equal(world.created, 0);
    assert.deepEqual(world.events, []);
  });

  it('is consulted before the window is created, before it is placed, and before the restore', async () => {
    const world = fakeWorld();
    const gate = async () => {
      world.events.push('gate');
      return { ok: true, waitedForUserMs: 0 };
    };
    await manager(world, freshDir(), { gate }).withWindow(async () => world.events.push('work'));
    const log = world.events;
    const at = (name, from = 0) => log.indexOf(name, from);
    assert.ok(at('gate') < at('create'), 'gate before create');
    assert.ok(at('gate', at('create')) < at('place'), 'gate between create and place');
    assert.ok(at('gate', at('work')) < at('raise:user-window'), 'gate before the restore');
  });

  it('skips the restore, and says so, when the user got busy meanwhile', async () => {
    const world = fakeWorld();
    let worked = false;
    // Quiet until the work is done, busy by the time the restore asks.
    const gate = async () => (worked ? { ok: false, userActive: true, waitedForUserMs: 15000 } : { ok: true, waitedForUserMs: 0 });
    const result = await manager(world, freshDir(), { gate }).withWindow(async () => {
      worked = true;
    });
    assert.equal(result.focusRestored, false);
    assert.match(result.focusRestoreError, /busy/);
    assert.equal(world.focusedId, 'agent-1');
  });

  it('adds the time spent waiting to the result', async () => {
    const world = fakeWorld();
    const gate = async () => ({ ok: true, waitedForUserMs: 100 });
    const result = await manager(world, freshDir(), { gate }).withWindow(noop);
    assert.ok(result.waitedForUserMs >= 100);
  });
});

describe('status', () => {
  it('never creates a window or launches Arc', async () => {
    const world = fakeWorld();
    const mgr = manager(world, freshDir());
    const empty = await mgr.status();
    assert.equal(empty.windowId, null);
    assert.equal(world.created, 0);
    await mgr.withWindow(noop);
    world.events.length = 0;
    await mgr.status();
    assert.ok(world.events.includes('list-nolaunch'));
    assert.ok(!world.events.includes('list'));
  });

  it('reports id, placement, display, minimized and Accessibility', async () => {
    const world = fakeWorld();
    const mgr = manager(world, freshDir());
    await mgr.withWindow(noop);
    world.state = { x: -900, y: 0, width: 800, height: 700 };
    const status = await mgr.status();
    assert.equal(status.windowId, 'agent-1');
    assert.equal(status.exists, true);
    assert.equal(status.placement, 'second-display');
    assert.equal(status.minimized, false);
    assert.equal(status.display.isMain, false);
    assert.deepEqual(status.accessibility, { available: true });
  });

  it('reports a minimized window as existing and as not on any display', async () => {
    const world = fakeWorld();
    const mgr = manager(world, freshDir());
    await mgr.withWindow(noop);
    world.windows[0].minimized = true;
    const status = await mgr.status();
    assert.equal(status.exists, true);
    assert.equal(status.minimized, true);
    assert.equal(status.display, null);
  });

  it('says how to grant Accessibility when it is missing', async () => {
    const world = fakeWorld({ accessibility: false });
    const status = await manager(world, freshDir()).status();
    assert.equal(status.accessibility.available, false);
    assert.match(status.accessibility.note, /Accessibility/);
  });
});

describe('the JXA that drives Arc', () => {
  // node --check cannot see inside a template literal, so a typo here would
  // first show up against the user's real Arc.
  for (const [name, body] of [['list', LIST_SCRIPT], ['create', CREATE_SCRIPT], ['open tab', OPEN_TAB_SCRIPT]]) {
    it(`the ${name} script parses together with the preamble`, () => {
      assert.doesNotThrow(() => new Function('P', `${PREAMBLE}\n${body}`));
    });
  }

  it('the preamble keeps the agent window out of the user\'s windows but not out of tab lookups', () => {
    assert.match(PREAMBLE, /visible\(\) && idOf\(w\) !== P\.agent_window_id/);
    assert.match(PREAMBLE, /function tabWindows/);
  });
});

describe("the user's own windows stay put", () => {
  it('moves a user window back when creating the agent window displaced it', async () => {
    const world = fakeWorld();
    world.moveUserOnCreate = true;
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.deepEqual(
      { x: world.userFrames['user-window'].x, y: world.userFrames['user-window'].y },
      { x: 1280, y: 31 },
      'the user window is back where it was'
    );
    assert.equal(result.userWindowsMovedBack, 1);
    assert.ok(world.events.includes('moveback:user-window'));
  });

  it('leaves user windows alone when nothing moved them', async () => {
    const world = fakeWorld();
    const result = await manager(world, freshDir()).withWindow(noop);
    assert.equal(result.userWindowsMovedBack, undefined);
    assert.ok(!world.events.some((e) => e.startsWith('moveback:')));
  });
});
