// The injected script is assembled from template literals, so `node --check`
// cannot see inside it. A syntax error in PREAMBLE or in the pageScript wrapper
// would otherwise surface only at runtime, on macOS, as the unhelpful "Arc
// returned no result" ScriptError.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { PREAMBLE } from '../src/jxa.js';
import { PAGE_LIB, pageScript } from '../src/page-lib.js';

const parses = (source) => {
  try {
    new vm.Script(source);
    return null;
  } catch (error) {
    return error.message;
  }
};

describe('the JXA preamble', () => {
  it('parses as JavaScript', () => {
    assert.equal(parses(PREAMBLE), null);
  });

  it('defines the helpers every tool body calls', () => {
    for (const name of ['liveWindows', 'mainWindow', 'requireArc', 'snapshot', 'locate', 'target', 'evalJs', 'describe', 'findSpace']) {
      assert.ok(PREAMBLE.includes(`function ${name}(`), `PREAMBLE should define ${name}`);
    }
  });

  it('never maps an empty Arc result to a bare null, which was the 0.3.0 regression', () => {
    assert.ok(PREAMBLE.includes('ScriptError'), 'evalJs must return a failure envelope, not null');
    assert.ok(!/return null;\s*\n\s*try \{ return JSON\.parse/.test(PREAMBLE), 'the old null collapse must be gone');
  });
});

describe('the page helper library', () => {
  it('parses as JavaScript', () => {
    assert.equal(parses(PAGE_LIB), null);
  });
});

describe('pageScript', () => {
  // Regression: the wrapper used to splice the body onto one line, so a body
  // whose last line was a comment commented out the closing brace.
  const bodies = [
    'return 1;',
    'return { a: 1 };',
    'let n = 2; return n * 3; // triple it',
    'return document.title // trailing comment, no semicolon',
    '// leading comment only\nreturn 42;',
    'var x = 1;\n// comment in the middle\nreturn x;',
    'return A.describe(A.one("h1"));'
  ];

  for (const body of bodies) {
    it(`produces a parseable script for ${JSON.stringify(body).slice(0, 52)}`, () => {
      assert.equal(parses(pageScript(body)), null);
    });
  }

  it('keeps a trailing line comment from swallowing the wrapper', () => {
    const script = pageScript('return 1; // done');
    const afterBody = script.slice(script.lastIndexOf('// done') + '// done'.length);
    assert.ok(afterBody.includes('\n'), 'the body must be followed by a newline, not the closing brace');
  });

  it('always wraps the body in the envelope contract', () => {
    const script = pageScript('return 1;');
    assert.ok(script.includes('A.envelope('), 'success path must build an envelope');
    assert.ok(script.includes('A.failure(e)'), 'failure path must build a failure envelope');
  });
});

describe('tab specifiers', () => {
  // A positional specifier is re-resolved on every Apple Event, so a tab
  // opened or closed by another process shifts it onto a different tab between
  // a lookup and the close or script that follows it.
  it('locate returns an id specifier, never a position', () => {
    const body = PREAMBLE.slice(PREAMBLE.indexOf('function locate('), PREAMBLE.indexOf('// Prefers a tab this agent opened'));
    assert.ok(body.includes('.tabs.byId('), 'locate must address the tab by id');
    assert.ok(!/\.tabs\[\w+\]/.test(body), 'locate must not return w.tabs[i]');
  });
});
