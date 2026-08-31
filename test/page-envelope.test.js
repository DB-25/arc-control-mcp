// The bug this release exists to fix: before the envelope, Arc handed back an
// empty string for a page script that threw, the Node side turned that into
// `null`, and every handler spread the null into a cheerful `{ ok: true }`. A
// batch of four calls in which nothing happened reported success four times.
//
// The contract that fixes it has to keep three outcomes apart: the page threw,
// the page returned nothing, and the page returned a legitimately falsy value.
// Those are the cases below.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { PAGE_LIB, pageScript } from '../src/page-lib.js';
import { unwrapPage } from '../src/tools/shared.js';
import { wrapUserCode } from '../src/tools/scripting.js';
import { ArcError } from '../src/jxa.js';

const TAB = { id: 'T1', title: 'Example', url: 'https://example.com/', location: 'unpinned', mine: true };

const envelope = (extra) => ({ __arc: 1, ok: true, ...extra });

// PAGE_LIB touches the DOM only inside its functions, so the whole injected
// script parses and runs in a bare vm context. That makes the real page-side
// envelope testable on Linux with no Arc and no DOM.
// The JSON round trip mirrors the real transport (Arc returns JSON text that
// jxa.js parses) and hands back objects from this realm, which a cross-realm
// deepEqual would otherwise reject on the prototype alone.
const runInPage = (body) => JSON.parse(JSON.stringify(vm.runInNewContext(pageScript(body))));

// A representative spread: expression bodies, statement bodies, comments,
// nested braces, template literals and the quote styles that a naive wrapper
// would break on.
const BODIES = [
  'return 1;',
  'return null;',
  'return document.title;',
  'return { a: 1, b: [2, 3] };',
  'var n = 2; return n * 3;',
  'throw new Error("boom");',
  'return `a ${1 + 1} b`;',
  "return 'single \\' quoted';",
  'return "}{";',
  'for (var i = 0; i < 3; i++) {} return i;',
  '// a comment above the code\nreturn A.all("p").length;',
  'if (!document.body) return null;\nreturn document.body.innerText;'
];

describe('pageScript produces a valid, envelope-wrapped script', () => {
  for (const body of BODIES) {
    it(`pageScript output parses as JavaScript for body: ${JSON.stringify(body)}`, () => {
      // Constructing the Script parses without running it, so a page body that
      // would only fail once injected is caught here instead.
      assert.doesNotThrow(() => new vm.Script(pageScript(body)));
    });
  }

  it('pageScript wraps the body in the envelope helpers rather than returning it raw', () => {
    const script = pageScript('return 1;');
    assert.ok(script.includes(PAGE_LIB), 'the helper library must be injected ahead of the body');
    assert.match(script, /A\.envelope\(/, 'the success path must build an envelope');
    assert.match(script, /A\.failure\(/, 'the throw path must build an envelope');
    assert.match(script, /__arc: 1/, 'the envelope marker must be present in the injected source');
    assert.ok(script.includes('return 1;'), 'the caller body must survive intact');
  });

  it('an expression wrapped by wrapUserCode still parses with a trailing line comment', () => {
    // pageScript splices the body onto one line, so comment safety comes from
    // wrapUserCode putting the `);` on a line of its own. This is the composed
    // path that execute_javascript actually sends, so it is the one to pin.
    const { body } = wrapUserCode('A.all("p").length // how many');
    assert.doesNotThrow(() => new vm.Script(pageScript(body)));
  });
});

describe('the page side of the envelope: threw, returned nothing, returned falsy', () => {
  it('a returned value arrives as ok true with the value under v', () => {
    assert.deepEqual(runInPage('return { title: "hi" };'), envelope({ v: { title: 'hi' } }));
  });

  it('a thrown page error arrives as ok false carrying the error name and message', () => {
    assert.deepEqual(runInPage('throw new TypeError("cannot read x");'), {
      __arc: 1,
      ok: false,
      name: 'TypeError',
      error: 'cannot read x'
    });
  });

  it('a page body that returns nothing is ok true with no v, not a failure', () => {
    // "Ran fine but produced no value" is a success. Only a throw is a failure.
    assert.deepEqual(runInPage('var unused = 1;'), envelope({}));
  });

  for (const [label, body, value] of [
    ['null', 'return null;', null],
    ['false', 'return false;', false],
    ['zero', 'return 0;', 0],
    ['an empty string', 'return "";', '']
  ]) {
    it(`a page value of ${label} is reported as ok true, not as a failure`, () => {
      assert.deepEqual(runInPage(body), envelope({ v: value }));
    });
  }

  it('a result that cannot be JSON encoded fails loudly instead of vanishing', () => {
    const out = runInPage('var o = {}; o.self = o; return o;');
    assert.equal(out.ok, false);
    assert.match(out.error, /not JSON-serialisable/);
  });

  it('an object with no JSON representation returns a note explaining the empty result', () => {
    const out = runInPage('function Widget() {} return new Widget();');
    assert.equal(out.ok, true);
    assert.deepEqual(Object.keys(out.v), []);
    assert.match(out.note, /Widget has no JSON representation/);
  });
});

describe('unwrapPage rejects anything that is not a well formed envelope', () => {
  const missing = /returned nothing recognisable/;

  it('unwrapPage throws when the whole output is missing', () => {
    assert.throws(() => unwrapPage(undefined), { name: 'Error', message: missing });
    assert.throws(() => unwrapPage(undefined), ArcError);
  });

  it('unwrapPage throws when the result is null, which is what the old code called success', () => {
    assert.throws(() => unwrapPage({ result: null, tab: TAB }), { message: missing });
  });

  it('unwrapPage throws when the result is the empty string Arc returns for a thrown script', () => {
    assert.throws(() => unwrapPage({ result: '', tab: TAB }), { message: missing });
  });

  it('unwrapPage throws when __arc is not 1, so a stray page object cannot pose as an envelope', () => {
    assert.throws(() => unwrapPage({ result: { __arc: 2, ok: true, v: 1 }, tab: TAB }), { message: missing });
    assert.throws(() => unwrapPage({ result: { ok: true, v: 1 }, tab: TAB }), { message: missing });
  });

  it('unwrapPage names Arc JavaScript blocking as the likely cause of a missing envelope', () => {
    // The actionable half of the message: without it the caller has no idea
    // which setting to go and change.
    assert.throws(() => unwrapPage({ result: null }), /Allow JavaScript from Apple Events/);
  });

  it('unwrapPage throws on ok false and carries the page error name and text', () => {
    assert.throws(
      () => unwrapPage({ result: { __arc: 1, ok: false, name: 'TypeError', error: 'x is not a function' }, tab: TAB }),
      (error) => {
        assert.ok(error instanceof ArcError, 'handlers rely on ArcError to mark caller-facing failures');
        assert.match(error.message, /The page script failed/);
        assert.match(error.message, /TypeError/, 'the page error name has to survive');
        assert.match(error.message, /x is not a function/, 'the page error text has to survive');
        return true;
      }
    );
  });
});

describe('unwrapPage passes legitimate values through', () => {
  // These four are the exact ambiguity behind the original bug: each one used
  // to be indistinguishable from "the script blew up".
  for (const [label, value] of [
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
    ['an empty array', []],
    ['NaN', Number.NaN]
  ]) {
    it(`unwrapPage passes a legitimate ${label} through instead of reporting failure`, () => {
      const out = unwrapPage({ result: { __arc: 1, ok: true, v: value }, tab: TAB });
      assert.deepEqual(out.result, value);
      assert.equal(out.tab, TAB);
    });
  }

  it('unwrapPage reports a missing v as undefined, which handlers turn into null themselves', () => {
    const out = unwrapPage({ result: { __arc: 1, ok: true }, tab: TAB });
    assert.equal(out.result, undefined);
    assert.equal('result' in out, true);
  });

  it('unwrapPage forwards the envelope note so the caller learns why v is empty', () => {
    const out = unwrapPage({ result: { __arc: 1, ok: true, v: {}, note: 'Widget has no JSON representation.' }, tab: TAB });
    assert.deepEqual(out.result, {});
    assert.match(out.note, /Widget/);
  });

  it('unwrapPage returns the tab untouched, including its mine flag', () => {
    const out = unwrapPage({ result: envelope({ v: 1 }), tab: TAB });
    assert.deepEqual(out.tab, TAB);
  });
});

describe('end to end: a thrown page script can never look like a success', () => {
  // With no DOM in the sandbox the last three throw a ReferenceError rather
  // than the DOM error a real page would raise. The point is the same: any
  // throw at all has to come back as ok false.
  const THROWING = [
    'throw new Error("boom");',
    'return document.querySelector("#nope").value;',
    'return undefinedGlobalFunction();',
    'A.setValue(document.createElement("h1"), "x");'
  ];

  for (const body of THROWING) {
    it(`page body reported as a failure, not ok true: ${JSON.stringify(body)}`, () => {
      // Runs the real injected script, then feeds the real envelope to the real
      // unwrapper. This is the whole regression path in one assertion.
      const result = runInPage(body);
      assert.equal(result.ok, false, 'the page side must mark it failed');
      assert.throws(() => unwrapPage({ result, tab: TAB }), ArcError, 'the Node side must raise it');
    });
  }

  it('four failing steps in a row produce four failures, not four cheerful successes', () => {
    // The reported symptom: a batch of four calls where nothing happened at all
    // came back ok on every step.
    const results = THROWING.map((body) => runInPage(body));
    const raised = results.filter((result) => {
      try {
        unwrapPage({ result, tab: TAB });
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(raised.length, 4);
  });
});
