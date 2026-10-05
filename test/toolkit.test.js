// The interaction and wait tools that need a page to do their work. The page
// half is covered by the integration tests against real Arc; what is checked
// here is everything Node decides before a page is involved: argument
// validation, the scripts parsing, and the hints a client gates on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { TOOLS, HANDLERS } from '../src/registry.js';
import { ArcError } from '../src/jxa.js';
import { pageScript } from '../src/page-lib.js';
import { typeScript, validateType } from '../src/tools/input.js';
import { searchScript, needlesFrom } from '../src/tools/wait.js';

const byName = (name) => TOOLS.find((tool) => tool.name === name);
const parses = (source) => {
  try {
    new vm.Script(source);
    return null;
  } catch (error) {
    return error.message;
  }
};

describe('tool hints', () => {
  it('wait_for_text is read-only like the other waits', () => {
    const { annotations } = byName('wait_for_text');
    assert.equal(annotations.readOnlyHint, true);
    assert.equal(annotations.destructiveHint, false);
  });

  for (const name of ['fill_form', 'type', 'hover']) {
    it(`${name} changes a page but is not destructive`, () => {
      const { annotations } = byName(name);
      assert.equal(annotations.readOnlyHint, false);
      assert.equal(annotations.destructiveHint, false);
      assert.equal(annotations.openWorldHint, true);
    });
  }

  it('type and wait_for_text advertise their limits in the schema', () => {
    const type = byName('type').inputSchema.properties;
    assert.equal(type.delay_ms.maximum, 250);
    assert.equal(byName('wait_for_text').inputSchema.properties.timeout_ms.maximum, 30000);
    assert.equal(byName('fill_form').inputSchema.properties.fields.maxItems, 50);
  });
});

describe('type validation, before any page is touched', () => {
  const base = { selector: '#q', tab_id: 'NOT-A-REAL-TAB-ID' };

  it('refuses empty text, control characters and over-long text', () => {
    assert.throws(() => validateType({ ...base, text: '' }), ArcError);
    assert.throws(() => validateType({ ...base, text: 'a\nb' }), /press_key/);
    assert.throws(() => validateType({ ...base, text: 'a\tb' }), /control character/);
    assert.throws(() => validateType({ ...base, text: 'x'.repeat(2001) }), /up to 2000/);
  });

  it('refuses a delay that cannot finish inside one call', () => {
    assert.throws(() => validateType({ ...base, text: 'x'.repeat(200), delay_ms: 250 }), /over the 25000ms/);
    assert.deepEqual(validateType({ ...base, text: 'x'.repeat(100), delay_ms: 250 }), { chars: 100, delay: 250 });
  });

  it('counts a code point once, so an emoji is one character', () => {
    assert.equal(validateType({ ...base, text: 'a\u{1F600}b' }).chars, 3);
  });

  it('is enforced through the registry, with the unreachable tab id never touched', async () => {
    await assert.rejects(() => HANDLERS.type({ ...base, text: 'a\nb' }), /press_key/);
    await assert.rejects(() => HANDLERS.type({ ...base, text: 'abc', delay_ms: 9999 }), /Invalid arguments for type/);
  });
});

describe('wait_for_text validation', () => {
  it('needs something to wait for, and refuses a pattern that matches everything', () => {
    assert.throws(() => needlesFrom({}), /texts, regex, or both/);
    assert.throws(() => needlesFrom({ texts: ['ok', ''] }), /empty string/);
    assert.throws(() => needlesFrom({ regex: '' }), /empty regex/);
  });

  it('rejects a regex that does not compile, naming the problem', () => {
    assert.throws(() => needlesFrom({ regex: '(unclosed' }), /regex does not compile/);
  });

  it('is enforced through the registry before any poll', async () => {
    await assert.rejects(
      () => HANDLERS.wait_for_text({ regex: '(', tab_id: 'NOT-A-REAL-TAB-ID' }),
      /regex does not compile/
    );
  });
});

describe('the injected scripts parse', () => {
  it('wait_for_text search, scoped and unscoped, with text and regex', () => {
    const needles = { texts: ['Saved', 'He said "hi"', "it's"], regex: 'order #\\d+' };
    assert.equal(parses(pageScript(searchScript(needles, {}))), null);
    assert.equal(parses(pageScript(searchScript(needles, { selector: 'text=Status', case_sensitive: true }))), null);
    assert.equal(parses(pageScript(searchScript({ texts: [], regex: 'a' }, {}))), null);
  });

  it('type, synchronous and delayed, with hostile text', () => {
    const text = '`${alert(1)}` \\ " \' </script>  ';
    assert.equal(parses(pageScript(typeScript({ selector: '#q', text }))), null);
    assert.equal(parses(pageScript(typeScript({ selector: '#q', text, delay_ms: 50, clear: true }))), null);
  });
});
