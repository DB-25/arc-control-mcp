// Geometry, configuration and Accessibility error mapping for the agent window.
// All pure: no display, no Arc, no osascript.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planPlacement, toAxRect, largestSecondary, displayOfWindow } from '../src/placement.js';
import { parseWindowConfig, PLACEMENTS } from '../src/window-config.js';
import { mapAxError, AxPermissionError, AxError, ACCESSIBILITY_NOTE, AUTOMATION_NOTE } from '../src/ax.js';

// This Mac: a 2560x1440 main display, and a portrait 1080x1920 to its left.
// NSScreen frames have a bottom-left origin on the main display.
const MAIN = { frame: { x: 0, y: 0, width: 2560, height: 1440 }, visibleFrame: { x: 0, y: 0, width: 2560, height: 1415 } };
const PORTRAIT = { frame: { x: -1080, y: -382, width: 1080, height: 1920 }, visibleFrame: { x: -1080, y: -382, width: 1080, height: 1895 } };
const SMALL = { frame: { x: 2560, y: 0, width: 800, height: 600 }, visibleFrame: { x: 2560, y: 0, width: 800, height: 575 } };

describe('coordinates', () => {
  it('converts a bottom-left NSScreen frame to a top-left Accessibility rectangle', () => {
    assert.deepEqual(toAxRect(PORTRAIT.frame, 1440), { x: -1080, y: -98, width: 1080, height: 1920 });
    assert.deepEqual(toAxRect(MAIN.frame, 1440), { x: 0, y: 0, width: 2560, height: 1440 });
  });

  it('picks the largest display that is not the main one', () => {
    assert.equal(largestSecondary([MAIN]), null);
    assert.equal(largestSecondary([MAIN, SMALL, PORTRAIT]).index, 2);
    assert.equal(largestSecondary([]), null);
  });

  it('says which display a window is on', () => {
    assert.equal(displayOfWindow([MAIN, PORTRAIT], { x: -900, y: 100, width: 800, height: 700 }).isMain, false);
    assert.equal(displayOfWindow([MAIN, PORTRAIT], { x: 300, y: 100, width: 800, height: 700 }).isMain, true);
    assert.equal(displayOfWindow([MAIN, PORTRAIT], { x: 9000, y: 9000, width: 10, height: 10 }), null);
  });
});

describe('planPlacement', () => {
  it('auto moves the window onto the second display, inside its usable area', () => {
    const plan = planPlacement({ screens: [MAIN, PORTRAIT], placement: 'auto', windowSize: { width: 1400, height: 900 } });
    assert.equal(plan.action, 'move');
    assert.equal(plan.placement, 'second-display');
    assert.equal(plan.display, 1);
    const { x, y, width, height } = plan.rect;
    assert.ok(x >= -1080 && x + width <= 0, 'inside the portrait display horizontally');
    assert.ok(y >= -98 && y + height <= -98 + 1895, 'inside the portrait display vertically');
    assert.equal(width, 1080, 'a window wider than the display is narrowed to fit');
  });

  it('auto with one display leaves the window alone, and does not minimize', () => {
    assert.deepEqual(planPlacement({ screens: [MAIN], placement: 'auto' }), { action: 'none', placement: 'none' });
  });

  it('second-display with one display leaves it alone and says why', () => {
    const plan = planPlacement({ screens: [MAIN], placement: 'second-display' });
    assert.equal(plan.action, 'none');
    assert.match(plan.note, /one display/);
  });

  it('minimized and none do not need any display information', () => {
    assert.deepEqual(planPlacement({ screens: [], placement: 'minimized' }), { action: 'minimize', placement: 'minimized' });
    assert.deepEqual(planPlacement({ screens: [MAIN, PORTRAIT], placement: 'none' }), { action: 'none', placement: 'none' });
  });

  it('has no corner placement: the choices are auto, second-display, minimized and none', () => {
    assert.deepEqual(PLACEMENTS, ['auto', 'second-display', 'minimized', 'none']);
  });
});

describe('parseWindowConfig', () => {
  it('defaults to a dedicated window with auto placement', () => {
    assert.deepEqual(parseWindowConfig({}), { mode: 'dedicated', placement: 'auto', warnings: [] });
  });

  it('reads both variables, case-insensitively', () => {
    const config = parseWindowConfig({ ARC_MCP_WINDOW: 'Space', ARC_MCP_WINDOW_PLACEMENT: 'MINIMIZED' });
    assert.equal(config.mode, 'space');
    assert.equal(config.placement, 'minimized');
  });

  it('falls back on a typo and reports it rather than refusing to start', () => {
    const config = parseWindowConfig({ ARC_MCP_WINDOW: 'popup', ARC_MCP_WINDOW_PLACEMENT: 'corner' });
    assert.equal(config.mode, 'dedicated');
    assert.equal(config.placement, 'auto');
    assert.equal(config.warnings.length, 2);
  });
});

describe('mapAxError', () => {
  it('maps -25211 and -1719 to the one-time Accessibility note', () => {
    for (const message of ['execution error: assistive access not allowed. (-25211)', 'Invalid index. (-1719)']) {
      const error = mapAxError(message);
      assert.ok(error instanceof AxPermissionError, message);
      assert.equal(error.message, ACCESSIBILITY_NOTE);
    }
  });

  it('says where to grant it', () => {
    assert.match(ACCESSIBILITY_NOTE, /System Settings > Privacy & Security > Accessibility/);
  });

  it('maps the System Events Automation grant to its own note', () => {
    const error = mapAxError('Not authorized to send Apple events to System Events. (-1743)');
    assert.ok(error instanceof AxPermissionError);
    assert.equal(error.message, AUTOMATION_NOTE);
  });

  it('keeps any other failure as a plain AxError, so it is not mistaken for a missing permission', () => {
    const error = mapAxError("Can't get window 3. (-1728)");
    assert.ok(error instanceof AxError && !(error instanceof AxPermissionError));
  });
});
