// The Accessibility driver with an injected script runner, so no osascript runs
// and no window is touched. What matters: the window id that reaches AppleScript
// source is validated, and the answers are parsed into the shapes the manager uses.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAxDriver, AxError, isArcApp, sameApp, ARC_BUNDLE_ID } from '../src/ax.js';

const ID = 'ABCDEF01-2345-6789-ABCD-EF0123456789';

describe('createAxDriver', () => {
  it('refuses a window id that is not the shape of one, since it goes into script source', async () => {
    const ax = createAxDriver(async () => assert.fail('must not run'));
    await assert.rejects(ax.raise('x" & (do shell script "id") & "'), AxError);
    await assert.rejects(ax.state('nope'), AxError);
  });

  it('lists the ids of the Arc windows Accessibility can see', async () => {
    const ax = createAxDriver(async () => `bigBrowserWindow-${ID}, bigBrowserWindow-${ID.toLowerCase()}, missing value`);
    assert.deepEqual(await ax.windowIds(), [ID, ID.toLowerCase()]);
  });

  it('reads whether Arc is frontmost and which window is focused', async () => {
    const ax = createAxDriver(async () => `true|bigBrowserWindow-${ID}`);
    assert.deepEqual(await ax.focus(), { frontmost: true, focusedId: ID });
    const none = createAxDriver(async () => 'false|');
    assert.deepEqual(await none.focus(), { frontmost: false, focusedId: null });
  });

  it('reads position, size and minimized', async () => {
    const ax = createAxDriver(async () => '-1080, -98, 800, 700, false');
    assert.deepEqual(await ax.state(ID), { x: -1080, y: -98, width: 800, height: 700, minimized: false });
  });

  it('raises by AXRaise and AXMain, and places by size then position', async () => {
    const scripts = [];
    const ax = createAxDriver(async (script) => {
      scripts.push(script);
      return '';
    });
    await ax.raise(ID);
    await ax.place(ID, { x: -1000.4, y: 20, width: 900, height: 700.2 });
    assert.match(scripts[0], /AXRaise/);
    assert.match(scripts[0], /AXMain/);
    assert.match(scripts[1], /set size of w to \{900, 700\}/);
    assert.match(scripts[1], /set position of w to \{-1000, 20\}/);
  });
});

describe('the frontmost application', () => {
  it('reads name and bundle id, splitting on the last bar so a name may contain one', async () => {
    const ax = createAxDriver(async () => 'Terminal|com.apple.Terminal');
    assert.deepEqual(await ax.frontApp(), { name: 'Terminal', bundleId: 'com.apple.Terminal' });
    const odd = createAxDriver(async () => 'A | B|com.example.ab');
    assert.deepEqual(await odd.frontApp(), { name: 'A | B', bundleId: 'com.example.ab' });
    const none = createAxDriver(async () => 'Thing|missing value');
    assert.deepEqual(await none.frontApp(), { name: 'Thing', bundleId: null });
  });

  it('refuses an answer it cannot read rather than guess an app', async () => {
    await assert.rejects(createAxDriver(async () => '').frontApp(), AxError);
  });

  it('activates by bundle id, falling back to the name, and never lets a name end the AppleScript string', async () => {
    const scripts = [];
    const ax = createAxDriver(async (script) => { scripts.push(script); return ''; });
    await ax.activateApp({ name: 'Terminal', bundleId: 'com.apple.Terminal' });
    assert.match(scripts[0], /set frontmost of \(first application process whose bundle identifier is "com\.apple\.Terminal"\) to true/);
    await ax.activateApp({ name: 'My "App"', bundleId: null });
    assert.match(scripts[1], /name is "My \\"App\\""/);
    await assert.rejects(ax.activateApp({ name: 'x"\nreturn (do shell script "id")', bundleId: null }), AxError);
  });
});

describe('isArcApp and sameApp', () => {
  it('know Arc by bundle id or name, and compare apps by bundle id when both have one', () => {
    assert.equal(isArcApp({ name: 'Arc', bundleId: ARC_BUNDLE_ID }), true);
    assert.equal(isArcApp({ name: 'Arc', bundleId: null }), true);
    assert.equal(isArcApp({ name: 'Terminal', bundleId: 'com.apple.Terminal' }), false);
    assert.equal(isArcApp(null), false);
    assert.equal(sameApp({ name: 'A', bundleId: 'x' }, { name: 'Renamed', bundleId: 'x' }), true);
    assert.equal(sameApp({ name: 'A', bundleId: null }, { name: 'A', bundleId: null }), true);
    assert.equal(sameApp({ name: 'A', bundleId: 'x' }, { name: 'A', bundleId: 'y' }), false);
    assert.equal(sameApp(null, null), false);
  });
});
