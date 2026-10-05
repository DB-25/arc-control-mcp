// Integration tests. These drive the REAL Arc browser on this Mac: they open
// tabs, navigate them and close them again. Nothing else here does that.
//
// How to run:
//   ARC_MCP_INTEGRATION=1 npm test
//
// Skipped otherwise, which is every default run and all of CI: Linux has no
// Arc, and a developer running `npm test` should not have their browser
// hijacked mid-task. They cover only what real Arc can prove: that a tab really
// moves, that a page error really surfaces as an error, that the counts
// handlers report match a real DOM, that a caller-supplied timeout really is
// clamped, and that a cancelled wait really does stop polling.
//
// Every tool call below passes an explicit tab_id. A call without one resolves
// to this agent's current tab and, failing that, to whatever tab the user is
// looking at, which is not a thing a test may reach for.
//
// Tabs are opened in the agent space when one exists, are tracked under a
// throwaway ARC_MCP_LABEL, and are closed by the test that opened them plus a
// close_own_tabs sweep at the end. The state directory is redirected to a temp
// directory, so a run cannot disturb the ownership file of a real agent.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The MCP client default request timeout, and the ceiling every caller-supplied
// wait is clamped to so a call cannot outlive it. Kept here rather than imported
// because the point is to check the shipped numbers from outside.
const CLIENT_DEADLINE_MS = 60000;
const MAX_CALLER_TIMEOUT_MS = 30000;
// A wait exits its loop between polls, so it can come back a little under the
// ceiling without having ignored it.
const POLL_SLACK_MS = 1000;

const REASON = process.env.ARC_MCP_INTEGRATION !== '1'
  ? 'set ARC_MCP_INTEGRATION=1 to run the tests that drive Arc'
  : process.platform !== 'darwin'
    ? `Arc runs on macOS only, and this is ${process.platform}`
    : null;

// node:test takes a string as "skipped, and here is why".
const skip = REASON ?? false;

let fixtureDir = null;
if (!REASON) {
  fixtureDir = mkdtempSync(join(tmpdir(), 'arc-integration-'));
  process.env.ARC_MCP_STATE_DIR = join(fixtureDir, 'state');
  process.env.ARC_MCP_LABEL ||= 'arc-control-integration';
}

// Dynamic imports, because state.js reads ARC_MCP_* once at import and the
// redirect above has to land first. Importing these on Linux is harmless: no
// module touches osascript until a handler is called.
const { handlers: navigation } = await import('../src/tools/navigation.js');
const { handlers: tabTools } = await import('../src/tools/tabs.js');
const { handlers: content } = await import('../src/tools/content.js');
const { handlers: interact } = await import('../src/tools/interact.js');
const { handlers: scripting } = await import('../src/tools/scripting.js');
const { handlers: snap } = await import('../src/tools/snapshot.js');
// Binds batch's tool lookup, as src/index.js does at startup.
await import('../src/registry.js');
const { ArcError } = await import('../src/jxa.js');
const state = await import('../src/state.js');

// Local files rather than a website: no network, no redirect, no cookie banner,
// and the DOM is exactly what these assertions expect.
const PAGE_ONE = `<!doctype html><html><head><meta charset="utf-8"><title>arc-control page one</title></head>
<body><h1 id="heading">Page one</h1><p class="row">alpha</p></body></html>`;

const PAGE_TWO = `<!doctype html><html><head><meta charset="utf-8"><title>arc-control page two</title></head>
<body><h1 id="heading">Page two</h1>
<p class="row">alpha</p><p class="row">beta</p><p class="row">gamma</p>
<input id="field" type="text" value="">
<button id="locked" disabled onclick="document.body.dataset.clicked='locked'"><span>Locked save</span></button>
<button id="open" onclick="document.body.dataset.clicked='open'"><span>Open save</span></button></body></html>`;

// A page where a synthetic event can do what no user could: a control under a
// backdrop, a hidden twin ahead of the visible one, disabled select and option.
const PAGE_THREE = `<!doctype html><html><head><meta charset="utf-8"><title>arc-control page three</title>
<style>#veil{position:fixed;inset:0;z-index:9;background:rgba(0,0,0,.3)}</style></head>
<body><button id="covered" onclick="document.body.dataset.covered='1'">Covered</button><div id="veil"></div>
<div style="display:none"><button onclick="document.body.dataset.twin='hidden'">Twin</button></div>
<button style="position:relative;z-index:10" onclick="document.body.dataset.twin='visible'">Twin</button>
<select id="off" disabled><option>a</option><option>b</option></select>
<select id="partial"><option>a</option><option disabled>b</option></select>
<input id="num" type="number"><input id="cb" type="checkbox"><input id="loose">
<form id="f" onsubmit="event.preventDefault();document.body.dataset.sent=String(Number(document.body.dataset.sent||0)+1)">
<input id="q" name="q"><input id="need" name="need" required></form>
<form id="g" onsubmit="event.preventDefault();document.body.dataset.gsent=String(Number(document.body.dataset.gsent||0)+1)"><input id="r" name="r"></form>
<script>document.getElementById('r').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('g').requestSubmit();});</script></body></html>`;

// What a model would see in a form: a label, a placeholder, a disabled button,
// two kinds of hidden subtree, and a button that rewrites the DOM shortly after.
const PAGE_SNAP = `<!doctype html><html><head><meta charset="utf-8"><title>arc-control snapshot page</title></head>
<body><h1>Snapshot page</h1>
<label for="email">Email</label><input id="email" type="email">
<input id="find" placeholder="Search things"><input id="pw" type="password" aria-label="Password" value="hunter2">
<button id="save" onclick="document.body.dataset.saved='1'">Save</button>
<button id="locked" disabled>Locked</button>
<a href="#top">Top link</a>
<div style="display:none"><button>Display none thing</button></div>
<div aria-hidden="true"><button>Aria hidden thing</button></div>
<div id="slot"><button id="swap" onclick="document.body.dataset.swapped=String(Number(document.body.dataset.swapped||0)+1)">Swap me</button></div>
<button id="later" onclick="setTimeout(function(){document.getElementById('slot').appendChild(document.createElement('hr'));document.body.dataset.late='1'},50)">Later</button>
</body></html>`;

let urlSnap = null;
let urlOne = null;
let urlTwo = null;
let urlThree = null;

/** Open a tab, hand its id to the body, and close it however the body ends. */
async function withTab(url, body) {
  const opened = await navigation.open_url({ url, activate: false });
  try {
    return await body(opened.tab.id, opened);
  } finally {
    await tabTools.close_tab({ tab_id: opened.tab.id });
  }
}

describe('integration: drives the real Arc browser', () => {
  before(() => {
    if (REASON) return;
    const one = join(fixtureDir, 'page-one.html');
    const two = join(fixtureDir, 'page-two.html');
    writeFileSync(one, PAGE_ONE);
    writeFileSync(two, PAGE_TWO);
    urlOne = pathToFileURL(one).href;
    urlTwo = pathToFileURL(two).href;
    const three = join(fixtureDir, 'page-three.html');
    writeFileSync(three, PAGE_THREE);
    urlThree = pathToFileURL(three).href;
  });

  after(async () => {
    if (REASON) return;
    // Safety net for a test that threw before its own cleanup ran.
    await tabTools.close_own_tabs({});
  });

  it('open_url opens a tab this agent owns, and close_own_tabs closes it again', { skip }, async () => {
    const opened = await navigation.open_url({ url: urlOne, activate: false });
    assert.equal(opened.ok, true);
    assert.equal(opened.tab.mine, true, 'a tab this agent opened must be flagged as its own');
    assert.equal(state.isOwned(opened.tab.id), true);
    assert.equal(typeof opened.openedIn, 'string', 'the response says which space or window it landed in');
    assert.match(opened.tab.url, /page-one\.html$/);

    const closed = await tabTools.close_own_tabs({});
    assert.equal(closed.ok, true);
    assert.ok(closed.closed >= 1, 'close_own_tabs has to close the tab it just opened');
    assert.deepEqual(state.ownedIds(), [], 'ownership is dropped once the tab is gone');
  });

  it('go_back actually moves the tab, rather than reporting a move that never happened', { skip }, async () => {
    await withTab(urlOne, async (tabId) => {
      await navigation.open_url({ url: urlTwo, new_tab: false, tab_id: tabId });

      const back = await navigation.go_back({ tab_id: tabId });
      assert.equal(back.ok, true, `go_back reported failure: ${back.note}`);
      assert.equal(back.action, 'went back');
      assert.match(back.from, /page-two\.html$/);
      assert.match(back.to, /page-one\.html$/, 'the tab has to end up on the previous page');
      assert.ok(back.historyLength >= 2);

      // Confirmed from the page itself, not from what go_back claims.
      const info = await content.get_page_info({ tab_id: tabId });
      assert.equal(info.title, 'arc-control page one');
    });
  });

  it('go_back reports failure, not success, when the tab has nowhere to go', { skip }, async () => {
    await withTab(urlOne, async (tabId) => {
      const back = await navigation.go_back({ tab_id: tabId });
      assert.equal(back.ok, false, 'a fresh tab has no back entry, and that is not a success');
      assert.match(back.note, /go back/);
    });
  });

  it('a thrown page script surfaces as an error, not as ok true with a null result', { skip }, async () => {
    // The 0.3.0 regression, against real Arc: this used to come back as
    // { ok: true, result: null }.
    await withTab(urlOne, async (tabId) => {
      await assert.rejects(
        () => scripting.execute_javascript({ tab_id: tabId, code: "throw new Error('integration boom')" }),
        (error) => {
          assert.ok(error instanceof ArcError);
          assert.match(error.message, /integration boom/);
          return true;
        }
      );
    });
  });

  it('execute_javascript returns the value of an expression and says which form it used', { skip }, async () => {
    await withTab(urlOne, async (tabId) => {
      const sum = await scripting.execute_javascript({ tab_id: tabId, code: '1 + 1' });
      assert.equal(sum.form, 'expression');
      assert.equal(sum.result, 2);

      const title = await scripting.execute_javascript({ tab_id: tabId, code: 'document.title' });
      assert.equal(title.result, 'arc-control page one');

      // The other silent-failure bug: this parses only as a statement body, and
      // a statement body yields a value only through return. It has to say so
      // rather than reporting a bare null.
      const statement = await scripting.execute_javascript({ tab_id: tabId, code: 'let n = 2; n * 3' });
      assert.equal(statement.form, 'statement');
      assert.equal(statement.result, null);
      assert.match(statement.note, /return/);

      const withReturn = await scripting.execute_javascript({ tab_id: tabId, code: 'let n = 2; return n * 3;' });
      assert.equal(withReturn.form, 'statement');
      assert.equal(withReturn.result, 6);
    });
  });

  it('fill on an h1 fails with an error naming the tag, rather than silently doing nothing', { skip }, async () => {
    await withTab(urlTwo, async (tabId) => {
      await assert.rejects(
        () => interact.fill({ tab_id: tabId, selector: '#heading', value: 'nope' }),
        (error) => {
          assert.ok(error instanceof ArcError);
          assert.match(error.message, /<h1>/);
          assert.match(error.message, /not an input/);
          return true;
        }
      );

      // The same call on a real input works, so the failure above is about the
      // target and not about fill being broken.
      const filled = await interact.fill({ tab_id: tabId, selector: '#field', value: 'hello' });
      assert.equal(filled.ok, true);
      assert.equal(filled.filled.value, 'hello');
    });
  });

  it('get_page_content reports matched above 1 for a multi-match selector', { skip }, async () => {
    await withTab(urlTwo, async (tabId) => {
      const all = await content.get_page_content({ tab_id: tabId, selector: '.row' });
      assert.equal(all.matched, 3, 'a partial answer must never be silent');
      assert.equal(all.returned, 3);
      for (const word of ['alpha', 'beta', 'gamma']) assert.match(all.text, new RegExp(word));

      // first_only still reports the full count, plus a note about the rest.
      const first = await content.get_page_content({ tab_id: tabId, selector: '.row', first_only: true });
      assert.equal(first.matched, 3);
      assert.equal(first.returned, 1);
      assert.match(first.note, /1 of 3 matches/);
    });
  });

  it('click refuses a disabled button found through its label, instead of reporting a click the page ignored', { skip }, async () => {
    await withTab(urlTwo, async (tabId) => {
      const locked = await interact.click({ tab_id: tabId, selector: 'text=Locked save', exact: true });
      assert.equal(locked.ok, false, 'a disabled button swallows the click, so this is not a success');
      assert.equal(locked.control.tag, 'button');
      assert.equal(locked.control.disabled, true);
      assert.match(locked.hint, /background/, 'an agent tab is hidden, and the hint has to say so');

      const label = await content.query_elements({ tab_id: tabId, selector: '#locked span' });
      assert.equal(label.elements[0].disabled, true, 'a label inside a disabled button reads as disabled');

      const open = await interact.click({ tab_id: tabId, selector: 'text=Open save', exact: true });
      assert.equal(open.ok, true);
      assert.equal(open.clicked.tag, 'span');
      assert.equal(open.control.tag, 'button', 'the control that took the click is reported alongside the match');

      const clicked = await scripting.execute_javascript({ tab_id: tabId, code: 'document.body.dataset.clicked' });
      assert.equal(clicked.result, 'open', 'only the enabled button ran its handler');
    });
  });

  it('text= prefers a visible match over a hidden twin earlier in the page', { skip }, async () => {
    await withTab(urlThree, async (tabId) => {
      const twin = await interact.click({ tab_id: tabId, selector: 'text=Twin', exact: true });
      assert.equal(twin.ok, true);
      assert.equal(twin.matches, 2);
      const which = await scripting.execute_javascript({ tab_id: tabId, code: 'document.body.dataset.twin' });
      assert.equal(which.result, 'visible', 'the hidden button sits first in the DOM and must not win');
    });
  });

  it('click warns when an overlay covers the target, since no user could have clicked it', { skip }, async () => {
    await withTab(urlThree, async (tabId) => {
      const covered = await interact.click({ tab_id: tabId, selector: '#covered' });
      assert.equal(covered.ok, true, 'the synthetic click still lands, and says so');
      assert.equal(covered.coveredBy, '<div#veil>');
      assert.match(covered.warning, /could not click/);
    });
  });

  it('select_option refuses a disabled select and a disabled option instead of setting them', { skip }, async () => {
    await withTab(urlThree, async (tabId) => {
      const off = await interact.select_option({ tab_id: tabId, selector: '#off', option: 'b' });
      assert.equal(off.ok, false);
      const partial = await interact.select_option({ tab_id: tabId, selector: '#partial', option: 'b' });
      assert.equal(partial.ok, false);
      const values = await scripting.execute_javascript({ tab_id: tabId, code: "document.querySelector('#off').value + document.querySelector('#partial').value" });
      assert.equal(values.result, 'aa', 'neither select may have changed');
    });
  });

  it('fill refuses values and inputs that cannot hold text, instead of reporting a fill that did not land', { skip }, async () => {
    await withTab(urlThree, async (tabId) => {
      await assert.rejects(() => interact.fill({ tab_id: tabId, selector: '#num', value: 'abc' }), /did not accept/);
      await assert.rejects(() => interact.fill({ tab_id: tabId, selector: '#cb', value: 'on' }), /Use click/);
      const fine = await interact.fill({ tab_id: tabId, selector: '#num', value: '42' });
      assert.equal(fine.ok, true);
    });
  });

  it('fill with submit reports what really happened to the form', { skip }, async () => {
    await withTab(urlThree, async (tabId) => {
      const loose = await interact.fill({ tab_id: tabId, selector: '#loose', value: 'x', submit: true });
      assert.equal(loose.ok, false, 'a field outside any form submits nothing');

      const invalid = await interact.fill({ tab_id: tabId, selector: '#q', value: 'x', submit: true });
      assert.equal(invalid.ok, false, 'a required sibling is empty, so the browser would refuse');
      assert.equal(invalid.invalid[0].name, 'need');

      await interact.fill({ tab_id: tabId, selector: '#need', value: 'y' });
      const sent = await interact.fill({ tab_id: tabId, selector: '#q', value: 'x', submit: true });
      assert.equal(sent.ok, true);
      assert.equal(sent.submitted, true);

      const own = await interact.fill({ tab_id: tabId, selector: '#r', value: 'x', submit: true });
      assert.equal(own.ok, true);
      const counts = await scripting.execute_javascript({ tab_id: tabId, code: 'document.body.dataset.sent + "/" + document.body.dataset.gsent' });
      assert.equal(counts.result, '1/1', 'a page that submits on Enter itself must not be submitted a second time');
    });
  });

  it('batch fails a step that reports { error } without an ok field', { skip }, async () => {
    await withTab(urlThree, async (tabId) => {
      const out = await scripting.batch({
        tab_id: tabId,
        steps: [
          { tool: 'get_page_content', args: { selector: '#does-not-exist' } },
          { tool: 'click', args: { selector: '#covered' } }
        ]
      });
      assert.equal(out.ok, false);
      assert.equal(out.results[0].ok, false);
      assert.equal(out.ran, 1, 'the batch stops at the failed read');
    });
  });

  it('a missing selector is a reported miss, not an empty success', { skip }, async () => {
    await withTab(urlOne, async (tabId) => {
      const missed = await content.get_page_content({ tab_id: tabId, selector: '#does-not-exist' });
      assert.match(missed.error, /No element matches/);
    });
  });

  it('an unknown tab id fails with the actionable message from friendly()', { skip }, async () => {
    await assert.rejects(
      () => content.get_page_info({ tab_id: 'NOT-A-REAL-TAB-ID' }),
      (error) => {
        assert.ok(error instanceof ArcError);
        assert.match(error.message, /No open Arc tab has id NOT-A-REAL-TAB-ID\./);
        assert.match(error.message, /list_tabs/);
        return true;
      }
    );
  });

  it('clamps a caller-supplied timeout_ms to the ceiling instead of honouring it', { skip }, async () => {
    // The P0, against real Arc. timeout_ms had no ceiling, so a caller asking
    // for 90000 was killed by the client at 60000 and its timedOut payload,
    // with waitedMs and the last counts, was thrown away. Asking for 90000 now
    // gives up at the ceiling with a real answer.
    //
    // This case takes about MAX_CALLER_TIMEOUT_MS to run, and that duration is
    // the assertion: there is no way to prove a wait was shortened except by
    // watching it end early.
    await withTab(urlOne, async (tabId) => {
      const started = Date.now();
      const out = await interact.wait_for_selector({
        tab_id: tabId,
        selector: '#never-appears',
        state: 'present',
        timeout_ms: 3 * MAX_CALLER_TIMEOUT_MS
      });
      const elapsed = Date.now() - started;

      assert.equal(out.ok, false, 'a selector that never appears is not a success');
      assert.equal(out.timedOut, true);
      assert.ok(
        elapsed < CLIENT_DEADLINE_MS,
        `the call took ${elapsed}ms, so the client would have abandoned it at ${CLIENT_DEADLINE_MS}ms`
      );
      assert.ok(
        out.waitedMs >= MAX_CALLER_TIMEOUT_MS - POLL_SLACK_MS,
        `gave up after only ${out.waitedMs}ms, well short of the ${MAX_CALLER_TIMEOUT_MS}ms ceiling`
      );
      assert.match(out.note, new RegExp(`${MAX_CALLER_TIMEOUT_MS}ms`), 'the note does not report the ceiling it used');
    });
  });

  it('stops a wait when the caller cancels, instead of polling Arc to the deadline', { skip }, async () => {
    // Every poll spawns an osascript process against the user's Arc, so a loop
    // that ignores notifications/cancelled keeps prodding their browser for a
    // result nobody will read.
    await withTab(urlOne, async (tabId) => {
      const cancelled = (error) => {
        assert.ok(error instanceof ArcError);
        assert.match(error.message, /Cancelled/);
        return true;
      };

      // Aborted before the first poll: nothing should reach Arc at all.
      await assert.rejects(
        () => interact.wait_for_selector(
          { tab_id: tabId, selector: '#never-appears', timeout_ms: MAX_CALLER_TIMEOUT_MS },
          { signal: AbortSignal.abort() }
        ),
        cancelled
      );

      // Aborted mid-wait: it has to stop at the next poll rather than at the
      // timeout, so the elapsed time is what proves the signal was noticed.
      const controller = new AbortController();
      const started = Date.now();
      const waiting = navigation.wait_for_load(
        { tab_id: tabId, url_contains: 'never-matches-this-url', timeout_ms: MAX_CALLER_TIMEOUT_MS },
        { signal: controller.signal }
      );
      controller.abort();
      await assert.rejects(() => waiting, cancelled);
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < MAX_CALLER_TIMEOUT_MS / 2,
        `the cancelled wait ran for ${elapsed}ms of its ${MAX_CALLER_TIMEOUT_MS}ms budget`
      );
    });
  });
});

describe('integration: snapshots and refs', () => {
  before(() => {
    if (REASON) return;
    const page = join(fixtureDir, 'page-snap.html');
    writeFileSync(page, PAGE_SNAP);
    urlSnap = pathToFileURL(page).href;
  });

  after(async () => {
    if (!REASON) await tabTools.close_own_tabs({});
  });

  const refOf = (text, role, name) => {
    const found = new RegExp(`- ${role} "${name}"[^\\n]*?\\[ref=(e\\d+)\\]`).exec(text);
    assert.ok(found, `no ${role} "${name}" line in:\n${text}`);
    return found[1];
  };
  const dataset = async (tabId, key) =>
    (await scripting.execute_javascript({ tab_id: tabId, code: `document.body.dataset.${key} || null` })).result;

  it('lists roles and accessible names, and leaves hidden subtrees out', { skip }, async () => {
    await withTab(urlSnap, async (tabId) => {
      const out = await snap.snapshot({ tab_id: tabId });
      assert.equal(out.ok, true);
      assert.match(out.snapshot, /- heading "Snapshot page" \[level=1\] \[ref=e\d+\]/);
      assert.match(out.snapshot, /- textbox "Email" \[ref=e\d+\]/, 'label[for] names the input');
      assert.match(out.snapshot, /- textbox "Search things" \[ref=e\d+\]/, 'a placeholder names an input with no label');
      assert.match(out.snapshot, /- button "Save" \[ref=e\d+\]/);
      assert.match(out.snapshot, /- button "Locked" \[ref=e\d+\] \(disabled\)/);
      assert.match(out.snapshot, /- link "Top link" \[ref=e\d+\] href="#top"/);
      assert.doesNotMatch(out.snapshot, /Display none thing/);
      assert.doesNotMatch(out.snapshot, /Aria hidden thing/);
      assert.match(out.snapshot, /- textbox "Password"/);
      assert.doesNotMatch(out.snapshot, /hunter2/, 'a password value never appears in a snapshot');
      assert.equal(out.truncated, undefined);
    });
  });

  it('keeps a ref for the same element across snapshots, and diff says unchanged', { skip }, async () => {
    await withTab(urlSnap, async (tabId) => {
      const first = await snap.snapshot({ tab_id: tabId });
      const second = await snap.snapshot({ tab_id: tabId });
      assert.equal(refOf(first.snapshot, 'button', 'Save'), refOf(second.snapshot, 'button', 'Save'));

      const same = await snap.snapshot({ tab_id: tabId, diff: true });
      assert.equal(same.diff, 'unchanged');
      assert.equal(same.snapshot, 'unchanged');

      await scripting.execute_javascript({ tab_id: tabId, code: "document.querySelector('#save').textContent = 'Save now'" });
      const changed = await snap.snapshot({ tab_id: tabId, diff: true });
      assert.equal(changed.diff, 'changes');
      assert.match(changed.snapshot, /## added or changed\n[^\n]*button "Save now"/);
      assert.match(changed.snapshot, /## removed\n[^\n]*button "Save"/);
    });
  });

  it('click by ref works and reports how long the page took to settle', { skip }, async () => {
    await withTab(urlSnap, async (tabId) => {
      const out = await snap.snapshot({ tab_id: tabId });
      const ref = refOf(out.snapshot, 'button', 'Save');
      const clicked = await interact.click({ tab_id: tabId, selector: `ref=${ref}` });
      assert.equal(clicked.ok, true);
      assert.equal(clicked.reResolved, undefined, 'the element was never replaced');
      assert.equal(typeof clicked.settledMs, 'number');
      assert.equal(await dataset(tabId, 'saved'), '1');
    });
  });

  it('settles after an action that changes the DOM a moment later', { skip }, async () => {
    await withTab(urlSnap, async (tabId) => {
      const clicked = await interact.click({ tab_id: tabId, selector: 'role=button[name="Later"]', settle_ms: 1000 });
      assert.equal(clicked.ok, true);
      assert.ok(clicked.mutations >= 1, 'the observer saw the DOM change');
      assert.equal(await dataset(tabId, 'late'), '1', 'the delayed update had landed by the time the click returned');

      const skipped = await interact.click({ tab_id: tabId, selector: '#save', settle_ms: 0 });
      assert.equal(skipped.settledMs, undefined, 'settle_ms 0 opts out of the wait');
    });
  });

  it('re-resolves a ref whose element was replaced by an identical one', { skip }, async () => {
    await withTab(urlSnap, async (tabId) => {
      const out = await snap.snapshot({ tab_id: tabId });
      const ref = refOf(out.snapshot, 'button', 'Swap me');
      await scripting.execute_javascript({
        tab_id: tabId,
        code: "var b = document.querySelector('#swap'); b.replaceWith(b.cloneNode(true)); document.querySelector('#swap').isConnected"
      });
      const clicked = await interact.click({ tab_id: tabId, selector: `ref=${ref}` });
      assert.equal(clicked.ok, true);
      assert.equal(clicked.reResolved, true);
      assert.equal(await dataset(tabId, 'swapped'), '1', 'the click reached the new element');
    });
  });

  it('fails a ref whose element is truly gone, saying it is stale and to snapshot again', { skip }, async () => {
    await withTab(urlSnap, async (tabId) => {
      const out = await snap.snapshot({ tab_id: tabId });
      const ref = refOf(out.snapshot, 'button', 'Swap me');
      await scripting.execute_javascript({ tab_id: tabId, code: "document.querySelector('#swap').remove()" });
      await assert.rejects(
        () => interact.click({ tab_id: tabId, selector: `ref=${ref}` }),
        (error) => {
          assert.match(error.message, /stale/);
          assert.match(error.message, /new snapshot/);
          return true;
        }
      );
      await assert.rejects(() => interact.click({ tab_id: tabId, selector: 'ref=e9999' }), /unknown on this page/);

      // wait_for_selector treats a gone ref as absent instead of throwing.
      const gone = await interact.wait_for_selector({ tab_id: tabId, selector: `ref=${ref}`, state: 'absent', timeout_ms: 2000 });
      assert.equal(gone.ok, true);
    });
  });

  it('role=, label= and placeholder= selectors find the same elements a snapshot names', { skip }, async () => {
    await withTab(urlSnap, async (tabId) => {
      const exact = await content.query_elements({ tab_id: tabId, selector: 'role=button[name="Save"]' });
      assert.equal(exact.total, 1);
      const partial = await content.query_elements({ tab_id: tabId, selector: 'role=button[name~="ock"]' });
      assert.equal(partial.total, 1);
      assert.equal(partial.elements[0].disabled, true);
      const none = await content.query_elements({ tab_id: tabId, selector: 'role=button[name="Aria hidden thing"]' });
      assert.equal(none.total, 0, 'a button hidden from the accessibility tree is not matched');

      const byLabel = await interact.fill({ tab_id: tabId, selector: 'label=Email', value: 'a@b.co' });
      assert.equal(byLabel.ok, true);
      assert.equal(byLabel.filled.attrs.id, 'email');
      const byPlaceholder = await interact.fill({ tab_id: tabId, selector: 'placeholder=Search', value: 'milk' });
      assert.equal(byPlaceholder.filled.attrs.id, 'find');

      const locked = await interact.click({ tab_id: tabId, selector: 'role=button[name="Locked"]' });
      assert.equal(locked.ok, false, 'honest failures still apply to a role selector');
      await assert.rejects(() => interact.click({ tab_id: tabId, selector: 'role=button[bogus' }), /Cannot parse the role selector/);
    });
  });

  it('interactive_only, scope, depth, boxes and max_chars shape the output, and a cut is reported', { skip }, async () => {
    await withTab(urlSnap, async (tabId) => {
      const flat = await snap.snapshot({ tab_id: tabId, interactive_only: true });
      assert.doesNotMatch(flat.snapshot, /heading/);
      assert.match(flat.snapshot, /^- textbox "Email"/m);

      const scoped = await snap.snapshot({ tab_id: tabId, scope: '#slot' });
      assert.match(scoped.snapshot, /Swap me/);
      assert.doesNotMatch(scoped.snapshot, /Save/);
      const missing = await snap.snapshot({ tab_id: tabId, scope: '#nope' });
      assert.equal(missing.ok, false);

      const boxed = await snap.snapshot({ tab_id: tabId, boxes: true });
      assert.match(boxed.snapshot, /\[box=\d+,\d+,\d+,\d+\] \[(in-viewport|offscreen)\]/);

      const cut = await snap.snapshot({ tab_id: tabId, max_chars: 120 });
      assert.equal(cut.truncated, true);
      assert.ok(cut.omittedLines > 0);
      assert.match(cut.snapshot, /# truncated: \d+ more lines/);
    });
  });
});

// Last, so every describe above can still read its fixtures while it runs.
after(() => {
  if (!REASON) rmSync(fixtureDir, { recursive: true, force: true });
});
