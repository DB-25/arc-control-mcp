// Two pure pieces of jxa.js, both exported for this file: jsLiteral, which
// encodes the parameters every script receives as `P`, and friendly, which
// turns a raw osascript failure into something the caller can act on.
// Nothing here shells out, so it runs on Linux with no Arc and no osascript.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { jsLiteral, friendly, ArcError } from '../src/jxa.js';

// Written as escapes so this file stays plain ASCII: a raw separator here would
// be invisible in a diff, which is the whole reason jsLiteral escapes them.
const LINE_SEP = '\u2028';
const PARA_SEP = '\u2029';

// Evaluating the literal in a fresh realm proves a JavaScript parser accepts
// it, and asking that realm to re-encode avoids comparing objects across realms
// (strict deepEqual rejects those on the prototype alone).
const reEncodeInScript = (literal) => vm.runInNewContext(`JSON.stringify(${literal})`);

describe('jsLiteral encodes parameters as a JavaScript literal', () => {
  const VALUES = [
    null,
    0,
    -1.5,
    true,
    false,
    '',
    'plain',
    'quotes " and \' and `',
    'newline\nand\ttab',
    'backslash \\ and slash /',
    [1, 'two', null],
    { tab_id: 'ABC-123', owned_ids: ['A', 'B'], agent_space: 'Agent' },
    { nested: { deep: [{ a: 1 }] } }
  ];

  for (const value of VALUES) {
    it(`jsLiteral round-trips ${JSON.stringify(value)}`, () => {
      assert.deepEqual(JSON.parse(jsLiteral(value)), value);
      // The literal is spliced into script source, so a JavaScript parser has to
      // accept it as well as JSON.parse does.
      assert.equal(reEncodeInScript(jsLiteral(value)), JSON.stringify(value));
    });
  }

  it('jsLiteral turns undefined into null, since a script cannot receive a hole', () => {
    assert.equal(jsLiteral(undefined), 'null');
    assert.equal(jsLiteral({ a: undefined }), '{}');
  });

  it('jsLiteral escapes U+2028, which older JavaScriptCore parsers reject in a string', () => {
    const out = jsLiteral(`before${LINE_SEP}after`);
    assert.ok(!out.includes(LINE_SEP), 'the raw separator must not reach the script source');
    assert.ok(out.includes('\\u2028'), 'it must be escaped, not dropped');
    assert.equal(vm.runInNewContext(`(${out})`), `before${LINE_SEP}after`);
  });

  it('jsLiteral escapes U+2029 as well', () => {
    const out = jsLiteral(`before${PARA_SEP}after`);
    assert.ok(!out.includes(PARA_SEP));
    assert.ok(out.includes('\\u2029'));
    assert.equal(vm.runInNewContext(`(${out})`), `before${PARA_SEP}after`);
  });

  it('jsLiteral escapes separators nested anywhere in the params object', () => {
    // runJxa passes a whole params object through, so page code and selectors
    // arrive nested rather than as a bare string.
    const out = jsLiteral({ page_code: `return "a${LINE_SEP}b";`, selector: `text=x${PARA_SEP}y` });
    assert.ok(!out.includes(LINE_SEP));
    assert.ok(!out.includes(PARA_SEP));
    assert.equal(out.match(/\\u2028/g).length, 1);
    assert.equal(out.match(/\\u2029/g).length, 1);
  });

  it('jsLiteral escapes every occurrence, not just the first', () => {
    const out = jsLiteral(`a${LINE_SEP}b${LINE_SEP}c${PARA_SEP}d${PARA_SEP}e`);
    assert.equal(out.match(/\\u2028/g).length, 2);
    assert.equal(out.match(/\\u2029/g).length, 2);
  });
});

describe('friendly maps sentinels thrown by the JXA preamble', () => {
  it('friendly explains TAB_NOT_FOUND and points at list_tabs', () => {
    const out = friendly('execution error: Error: TAB_NOT_FOUND:ABC-123');
    assert.match(out, /No open Arc tab has id ABC-123\./);
    assert.match(out, /list_tabs/);
  });

  it('friendly keeps the trailing osascript code out of the extracted tab id', () => {
    // osascript appends its own " (-2700)" to the thrown message. Leaking that
    // into the id would send the caller looking for a tab called "ABC-123 (-2700)".
    const out = friendly('execution error: Error: TAB_NOT_FOUND:ABC-123 (-2700)');
    assert.match(out, /id ABC-123\./);
    assert.ok(!out.includes('-2700'), out);
  });

  it('friendly explains SPACE_NOT_FOUND and points at list_spaces', () => {
    const out = friendly('execution error: Error: SPACE_NOT_FOUND:Agent (-2700)');
    assert.match(out, /No Arc space matches "Agent"\./);
    assert.match(out, /list_spaces/);
    assert.ok(!out.includes('-2700'), out);
  });

  it('friendly explains SELECTOR_NO_MATCH with the selector it was given', () => {
    const out = friendly('execution error: Error: SELECTOR_NO_MATCH:#login > input[name="q"] (-2700)');
    assert.match(out, /No element on the page matches the selector "#login > input\[name="q"\]"\./);
    assert.ok(!out.includes('-2700'), out);
  });

  it('friendly finds a sentinel on a middle line of a multi-line failure', () => {
    const out = friendly('osascript: something happened\nError: TAB_NOT_FOUND:Z9 (-2700)\nmore noise');
    assert.match(out, /id Z9\./);
  });

  it('friendly explains ARC_NOT_RUNNING and names the tool that starts Arc', () => {
    assert.match(friendly('execution error: Error: ARC_NOT_RUNNING (-2700)'), /Arc is not running\..*open_url/s);
  });

  it('friendly explains ARC_NO_WINDOW as a window problem, not a launch problem', () => {
    const out = friendly('execution error: Error: ARC_NO_WINDOW (-2700)');
    assert.match(out, /no open windows/);
    assert.match(out, /Cmd-N/);
  });
});

describe('friendly maps macOS automation failures', () => {
  const PERMISSION = [
    ['the -1743 error code', 'osascript is not allowed to send Apple events to Arc. (-1743)'],
    ['a "not authorized" message', 'Not authorized to send Apple events to Arc.'],
    ['an assistive access message', 'osascript requires assistive access to control this application']
  ];

  for (const [label, message] of PERMISSION) {
    it(`friendly turns ${label} into the Automation settings path`, () => {
      const out = friendly(message);
      assert.match(out, /Permission denied: controlling Arc needs automation access\./);
      assert.match(out, /System Settings > Privacy & Security > Automation/);
      assert.match(out, /restart the app/);
    });
  }

  it('friendly recognises the Arc "JavaScript from Apple Events" block', () => {
    const out = friendly('Arc got an error: Executing JavaScript through AppleScript is not allowed.');
    assert.match(out, /Arc is blocking JavaScript from Apple Events\./);
    assert.match(out, /Arc > Settings > Advanced/);
  });

  it('friendly recognises the -600 "not running" code', () => {
    assert.match(friendly('Arc got an error: Connection is invalid. (-600)'), /Arc is not running\./);
  });

  it("friendly recognises AppleScript's \"isn't running\" wording", () => {
    assert.match(friendly("Application isn't running."), /Arc is not running\./);
  });

  it('friendly passes an unrecognised message through unchanged, hiding nothing', () => {
    const raw = 'osascript: totally novel failure nobody has mapped yet';
    assert.equal(friendly(raw), raw);
  });

  it('friendly leaves an empty message alone rather than inventing a cause', () => {
    assert.equal(friendly(''), '');
  });
});

describe('ArcError marks a failure as the caller\'s problem rather than a bug', () => {
  it('ArcError is an Error subclass, which index.js branches on', () => {
    const error = new ArcError('nope');
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ArcError);
    assert.equal(error.message, 'nope');
  });
});
