// The gate as the registry applies it, and the rule that every tool must say
// which side of it it is on. The shared activity gate is replaced with a user
// who never pauses, so no gated handler is ever reached: nothing here can run
// osascript or touch Arc.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, HANDLERS } from '../src/registry.js';
import { activity, GATED_TOOLS } from '../src/user-activity.js';

// Every tool that is not in GATED_TOOLS is background work: reads, page
// scripting, history, closing tabs, and the batch wrapper (whose steps are
// gated one by one). A new tool must be added to one list or the other here.
const NEVER_GATED = [
  'list_tabs', 'get_current_tab', 'close_tab', 'close_own_tabs', 'arc_status',
  'go_back', 'go_forward', 'reload_tab', 'wait_for_load', 'list_spaces',
  'get_page_content', 'get_page_info', 'get_html', 'get_links', 'query_elements',
  'wait_for_selector', 'click', 'fill', 'select_option', 'press_key', 'scroll',
  'execute_javascript', 'batch', 'stop_loading',
  // Local data: Arc's files on disk, never Arc itself.
  'sidebar_tree', 'find_stale_tabs', 'search_archive', 'search_history',
  // Page-level work inside a tab, which never raises a window.
  'snapshot', 'wait_for_text', 'fill_form', 'hover', 'type', 'capture_start', 'capture_read', 'network_entries',
  // CDP input and observation reach a background tab without bringing it forward.
  'cdp_status', 'trusted_click', 'trusted_type', 'trusted_press_key', 'trusted_hover',
  'drag', 'upload_file', 'handle_dialog', 'console_messages', 'network_requests'
];

const realWait = activity.wait;
afterEach(() => {
  activity.wait = realWait;
});

const userNeverPauses = () => {
  activity.wait = async () => ({ ok: false, userActive: true, waitedForUserMs: 15000, idleMs: 12 });
};

describe('every tool is classified', () => {
  it('is either gated or explicitly background work', () => {
    const known = new Set([...Object.keys(GATED_TOOLS), ...NEVER_GATED]);
    const unclassified = TOOLS.map((t) => t.name).filter((name) => !known.has(name));
    assert.deepEqual(unclassified, [], 'decide whether each of these can change the screen or the focus');
  });

  it('names no tool that does not exist', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const name of [...Object.keys(GATED_TOOLS), ...NEVER_GATED]) assert.ok(names.has(name), `${name} is not a tool`);
  });
});

describe('the registry holds gated tools back', () => {
  it('switch_to_tab returns userActive without reaching Arc', async () => {
    userNeverPauses();
    const result = await HANDLERS.switch_to_tab({ tab_id: 'a3a2d5c4-0000-4000-8000-000000000000' });
    assert.equal(result.ok, false);
    assert.equal(result.userActive, true);
    assert.match(result.error, /using the Mac/);
  });

  it('focus_space and open_url (new tab, activate) are held back too', async () => {
    userNeverPauses();
    assert.equal((await HANDLERS.focus_space({ space: 'Agent' })).userActive, true);
    assert.equal((await HANDLERS.open_url({ url: 'https://example.com' })).userActive, true);
    assert.equal((await HANDLERS.open_url({ url: 'https://example.com', new_tab: false, activate: true })).userActive, true);
    assert.equal((await HANDLERS.open_url({ url: 'https://example.com', little_arc: true })).userActive, true);
  });

  it('a gated step fails a batch, and is reported as a failure rather than a success', async () => {
    userNeverPauses();
    const result = await HANDLERS.batch({ steps: [{ tool: 'switch_to_tab', args: { tab_id: 'a3a2d5c4-0000-4000-8000-000000000000' } }] });
    assert.equal(result.ok, false);
    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[0].result.userActive, true);
  });

  it('a malformed call is still an argument error, not a wait', async () => {
    let consulted = false;
    activity.wait = async () => {
      consulted = true;
      return { ok: true, waitedForUserMs: 0 };
    };
    await assert.rejects(HANDLERS.open_url({}), /Invalid arguments for open_url/);
    assert.equal(consulted, false);
  });
});
