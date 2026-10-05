// The safety-relevant half of the tool surface: the hints a client gates on,
// and the one description that has to warn about what a bare call destroys.
//
// These assert specific values rather than shape, because that is where the
// bugs were. execute_javascript and batch both claimed destructiveHint: false
// while being able to submit forms, delete data and close tabs, and a refactor
// could flip any of these back without a single call behaving differently.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/registry.js';
import { read, write } from '../src/tools/shared.js';
import * as content from '../src/tools/content.js';

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

function hints(name) {
  const tool = byName.get(name);
  assert.ok(tool, `there is no tool named ${name}, so this test is checking nothing`);
  return tool.annotations;
}

// Tools that only script an arbitrary web page. Taken from content.js itself so
// a tool added to that module is covered without editing this list.
const CONTENT_TOOLS = content.tools.map((tool) => tool.name);
const SCRIPTING_TOOLS = ['execute_javascript', 'batch'];

// Tools that read or move Arc's own tab and space bookkeeping and never touch
// page content. openWorldHint exists to describe untrusted external content, so
// these are the only tools entitled to say false.
const ARC_METADATA_TOOLS = [
  'list_tabs',
  'get_current_tab',
  'switch_to_tab',
  'close_tab',
  'close_own_tabs',
  'arc_status',
  'list_spaces',
  'focus_space'
];

// Tools that read Arc's own data files and never touch a page or Arc itself.
const LOCAL_DATA_TOOLS = ['sidebar_tree', 'find_stale_tabs', 'search_archive', 'search_history'];

describe('destructive hints match what the tool can actually do', () => {
  for (const name of SCRIPTING_TOOLS) {
    it(`${name} admits it is destructive, since arbitrary code can submit or delete anything`, () => {
      assert.equal(hints(name).destructiveHint, true);
      assert.equal(hints(name).readOnlyHint, false, `${name} cannot be read-only and run arbitrary code`);
    });
  }

  for (const name of ['close_tab', 'close_own_tabs']) {
    it(`${name} admits it is destructive, since a closed tab does not come back`, () => {
      assert.equal(hints(name).destructiveHint, true);
      assert.equal(hints(name).readOnlyHint, false);
    });
  }

  it('no tool outside those four claims to be destructive by accident', () => {
    // A tripwire in the other direction: a tool that is not destructive but
    // says it is gets needlessly gated by a cautious client.
    const destructive = TOOLS.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name);
    assert.deepEqual(destructive.sort(), [...SCRIPTING_TOOLS, 'close_tab', 'close_own_tabs'].sort());
  });
});

describe('openWorldHint marks the tools that touch untrusted pages', () => {
  for (const name of CONTENT_TOOLS) {
    it(`${name} is open-world, because the page it reads is arbitrary and untrusted`, () => {
      assert.equal(hints(name).openWorldHint, true);
    });
  }

  for (const name of SCRIPTING_TOOLS) {
    it(`${name} is open-world, because it runs against an arbitrary untrusted page`, () => {
      assert.equal(hints(name).openWorldHint, true);
    });
  }

  it('only the Arc bookkeeping tools are closed-world', () => {
    const closedWorld = TOOLS.filter((tool) => !tool.annotations.openWorldHint).map((tool) => tool.name);
    assert.deepEqual(
      closedWorld.sort(),
      [...ARC_METADATA_TOOLS, ...LOCAL_DATA_TOOLS].sort(),
      'a tool that reads page content must not be marked closed-world'
    );
  });
});

describe('local data tools only read', () => {
  for (const name of LOCAL_DATA_TOOLS) {
    it(`${name} is read-only, non-destructive, idempotent and closed-world`, () => {
      assert.deepEqual(hints(name), {
        title: hints(name).title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      });
    });
  }
});

describe('every tool carries a display title', () => {
  it('has a top-level title, which is what the spec tells a client to prefer', () => {
    for (const tool of TOOLS) {
      assert.equal(typeof tool.title, 'string', `${tool.name} has no top-level title`);
      assert.ok(tool.title.trim().length > 0, `${tool.name} has an empty title`);
    }
  });

  it('derives that title from annotations.title rather than repeating it', () => {
    // registry.js fills the top-level title in from the annotation, so the two
    // drifting apart means the derivation was bypassed.
    for (const tool of TOOLS) {
      assert.equal(tool.title, tool.annotations.title, `${tool.name} title and annotations.title disagree`);
    }
  });
});

describe('the annotation helpers', () => {
  it('rejects a positional boolean, which used to mislabel a destructive tool as safe', () => {
    // This guard already caught a real bug. write("Close Tab", true) once meant
    // destructive; after the signature changed it would quietly resolve to
    // destructive: false, and the worst outcome here is a destructive tool a
    // client believes is safe. So a stale call site has to crash at import.
    assert.throws(() => write('Close Tab', true), /takes an options object/);
    // false is the more dangerous of the two, because it reads like a valid
    // "not destructive" at the call site.
    assert.throws(() => write('Close Tab', false), /takes an options object/);
    assert.throws(() => write('Close Tab', null), /takes an options object/);
  });

  it('defaults a write tool to not-destructive, not-idempotent and open-world', () => {
    assert.deepEqual(write('Thing'), {
      title: 'Thing',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    });
    assert.deepEqual(write('Thing', {}), write('Thing'), 'an empty options object is the same as none');
  });

  it('applies each write option it is given', () => {
    assert.equal(write('Thing', { destructive: true }).destructiveHint, true);
    assert.equal(write('Thing', { idempotent: true }).idempotentHint, true);
    assert.equal(write('Thing', { openWorld: false }).openWorldHint, false);
  });

  it('defaults a read tool to read-only, idempotent and open-world', () => {
    assert.deepEqual(read('Thing'), {
      title: 'Thing',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    });
    assert.equal(read('Thing', { openWorld: false }).openWorldHint, false);
  });
});

describe('close_tab warns about the tab a bare call would close', () => {
  const description = () => byName.get('close_tab').description;

  it('says that with no tab_id it can close the tab the user is looking at', () => {
    // The substance, not the wording: a rewrite is fine, dropping the warning
    // is not. This is the one tool whose default target is the user's own tab.
    const text = description();
    assert.match(text, /no tab_id/i, 'the description no longer says what happens with no tab_id');
    assert.match(text, /user/i, 'the description no longer mentions the user');
    assert.match(text, /active|actively|looking at/i, "the description no longer names the user's active tab");
  });

  it('says the close cannot be undone', () => {
    assert.match(
      description(),
      /cannot be undone|can not be undone|irreversible|permanent/i,
      'the description no longer says closing is irreversible'
    );
  });

  it('points at the safer alternatives', () => {
    const text = description();
    assert.match(text, /list_tabs/, 'the description no longer says where to get a tab_id');
    assert.match(text, /close_own_tabs/, 'the description no longer offers the safe way to clean up');
  });
});
