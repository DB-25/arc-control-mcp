// The second silent-failure bug: `let n = 2; n * 3` used to come back as null,
// because the injected script was always built as an expression and a statement
// body made it fail to parse. Arc answers an unparseable script with an empty
// string, so the caller saw a successful null.
//
// wrapUserCode decides the form in Node, where a parse error is catchable, and
// refuses to send code that parses as neither.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { wrapUserCode } from '../src/tools/scripting.js';
import { ArcError } from '../src/jxa.js';

describe('wrapUserCode picks the expression form for expressions', () => {
  const EXPRESSIONS = [
    '1 + 1',
    '({ a: 1 })',
    '{ a: 1 }',
    'document.title',
    'document.querySelectorAll("a").length',
    'A.describe(A.one("text=Sign in"))',
    '[1, 2, 3].map(function (n) { return n * 2; })',
    'window.location.href',
    'null',
    'false',
    '0'
  ];

  for (const code of EXPRESSIONS) {
    it(`wrapUserCode treats ${JSON.stringify(code)} as an expression`, () => {
      const { form, body } = wrapUserCode(code);
      assert.equal(form, 'expression');
      assert.ok(body.includes(code), 'the caller code must be spliced in unchanged');
    });
  }

  it('wrapUserCode returns the value of an expression through return', () => {
    // Without the `return` an expression body would evaluate and discard, which
    // is the null-result bug seen from the other side.
    assert.equal(wrapUserCode('1 + 1').body, 'return (\n1 + 1\n);');
  });

  it('wrapUserCode puts the closing brace on its own line so a trailing comment cannot eat it', () => {
    const { form, body } = wrapUserCode('1 + 1 // add them');
    assert.equal(form, 'expression');
    assert.equal(body, 'return (\n1 + 1 // add them\n);');
    // Proof rather than eyeballing: the wrapped body still parses.
    assert.doesNotThrow(() => new Function('A', body));
  });
});

describe('wrapUserCode picks the statement form for statement bodies', () => {
  const STATEMENTS = [
    'let n = 2; n * 3',
    "throw new Error('boom')",
    'for (var i = 0; i < 3; i++) {}',
    'const el = A.one("h1"); return el ? el.innerText : null;',
    'return document.title;',
    'var x = 1;',
    'if (document.body) { return 1; } else { return 2; }',
    'while (false) {}'
  ];

  for (const code of STATEMENTS) {
    it(`wrapUserCode treats ${JSON.stringify(code)} as a statement body`, () => {
      const { form, body } = wrapUserCode(code);
      assert.equal(form, 'statement');
      assert.equal(body, code, 'a statement body is sent verbatim');
    });
  }

  it('wrapUserCode leaves code that already says return alone', () => {
    // Wrapping `return x` in `return (...)` would be a syntax error, so the
    // statement form has to win here.
    const { form, body } = wrapUserCode('return 1 + 1;');
    assert.equal(form, 'statement');
    assert.equal(body, 'return 1 + 1;');
  });

  it('wrapUserCode reports the form, so a null result is attributable', () => {
    // execute_javascript surfaces `form` to the caller and adds a hint when a
    // statement body produced nothing. That only works if form is accurate.
    assert.equal(wrapUserCode('let n = 2; n * 3').form, 'statement');
    assert.equal(wrapUserCode('2 * 3').form, 'expression');
  });
});

describe('wrapUserCode refuses code that parses as neither', () => {
  const BROKEN = [
    ['a redeclared const', 'const x = 1; const x = 2;', /already been declared/],
    ['an unfinished function', 'function (', /function/i],
    ['a stray closing brace', '}{', /Unexpected/],
    ['an unclosed string', 'return "abc', /Invalid or unexpected token/],
    ['an unclosed paren', 'A.one("h1"', /Unexpected|missing/i]
  ];

  for (const [label, code, expected] of BROKEN) {
    it(`wrapUserCode throws an ArcError for ${label} and quotes the parser`, () => {
      assert.throws(
        () => wrapUserCode(code),
        (error) => {
          assert.ok(error instanceof ArcError, 'must be an ArcError so index.js reports it as a caller problem');
          assert.match(error.message, /does not parse/);
          assert.match(error.message, expected, 'the real parser complaint has to reach the caller');
          return true;
        }
      );
    });
  }

  it('wrapUserCode says nothing was sent to Arc, so the caller knows the page is untouched', () => {
    assert.throws(() => wrapUserCode('}{'), /nothing was sent to Arc/);
  });
});
