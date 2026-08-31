// Zod is the single source of truth: the advertised JSON Schema is generated
// from it, and the same schema validates arguments before a handler runs.
// Before this, nothing validated arguments at all, so a wrong-typed argument
// surfaced as a confusing page-script error from inside Arc.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { TOOLS, HANDLERS, MODULE_NAMES } from '../src/registry.js';
import { friendly, PREAMBLE, ArcError } from '../src/jxa.js';
import { scoped } from '../src/tools/shared.js';

const SRC_TOOLS = fileURLToPath(new URL('../src/tools/', import.meta.url));

describe('Zod is the only place a schema is written', () => {
  it('every tool module declares input, never a hand-written inputSchema', async () => {
    for (const name of MODULE_NAMES) {
      const module = await import(`../src/tools/${name}.js`);
      for (const tool of module.tools) {
        assert.equal(
          typeof tool.input?.safeParse,
          'function',
          `${name}.${tool.name} has no Zod input schema`
        );
        assert.equal(
          tool.inputSchema,
          undefined,
          `${name}.${tool.name} hand-writes an inputSchema, which would drift from its validator`
        );
      }
    }
  });

  it('no tool module contains a raw inputSchema literal', () => {
    for (const file of readdirSync(SRC_TOOLS).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(join(SRC_TOOLS, file), 'utf8');
      assert.doesNotMatch(
        source,
        /^\s*inputSchema:/m,
        `${file} declares inputSchema directly, so its validator and its advertised schema can disagree`
      );
    }
  });

  it('the generated schema is a clean object schema with no $schema key', () => {
    for (const tool of TOOLS) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} is not an object schema`);
      assert.equal(typeof tool.inputSchema.properties, 'object', `${tool.name} has no properties`);
      assert.equal(
        tool.inputSchema.$schema,
        undefined,
        `${tool.name} leaks a $schema key, which belongs to a standalone document`
      );
    }
  });

  it('does not advertise the private active-tab flag as an argument', () => {
    for (const tool of TOOLS) {
      assert.equal(
        tool.inputSchema.properties.__allowActiveTab,
        undefined,
        `${tool.name} exposes an internal flag as a caller-settable argument`
      );
    }
  });
});

describe('arguments are validated before a handler runs', () => {
  const cases = [
    { tool: 'click', args: { tab_id: 'x', selector: 123 }, names: 'selector' },
    { tool: 'fill', args: { tab_id: 'x', selector: 'h1', value: {} }, names: 'value' },
    { tool: 'query_elements', args: { tab_id: 'x' }, names: 'selector' },
    { tool: 'get_page_content', args: { tab_id: 'x', max_chars: 'lots' }, names: 'max_chars' },
    { tool: 'switch_to_tab', args: {}, names: 'tab_id' },
    { tool: 'list_tabs', args: { scope: 'everything' }, names: 'scope' },
    { tool: 'scroll', args: { tab_id: 'x', direction: 'sideways' }, names: 'direction' },
    { tool: 'wait_for_selector', args: { tab_id: 'x', selector: 'h1', state: 'maybe' }, names: 'state' },
    { tool: 'batch', args: { steps: 'not-an-array' }, names: 'steps' },
    { tool: 'execute_javascript', args: { tab_id: 'x' }, names: 'code' }
  ];

  for (const { tool, args, names } of cases) {
    it(`${tool} rejects a bad ${names} and names it, without reaching Arc`, async () => {
      await assert.rejects(
        () => HANDLERS[tool](args),
        (error) => {
          assert.ok(error instanceof ArcError, `${tool} threw ${error.constructor.name}, not ArcError`);
          assert.match(error.message, new RegExp(`Invalid arguments for ${tool}`));
          assert.match(error.message, new RegExp(names));
          return true;
        }
      );
    });
  }

  it('rejects a timeout above the ceiling rather than letting the client time out', async () => {
    await assert.rejects(
      () => HANDLERS.wait_for_selector({ tab_id: 'x', selector: 'h1', timeout_ms: 90000 }),
      /timeout_ms/
    );
  });

  it('applies declared defaults, so a handler never has to guess', async () => {
    // The registry strips `input` before publishing a tool, so the live schema
    // comes from the module rather than from TOOLS.
    const { tools } = await import('../src/tools/interact.js');
    const parsed = tools.find((t) => t.name === 'click').input.parse({ selector: 'h1' });
    assert.equal(parsed.nth, 0);
    assert.equal(parsed.exact, false);
    assert.equal(parsed.verbose, false);
  });

  it('never publishes the Zod schema itself, only the generated JSON Schema', () => {
    for (const tool of TOOLS) {
      assert.equal(tool.input, undefined, `${tool.name} ships a live Zod object over the wire`);
    }
  });
});

describe('a changing tool never resolves to the tab the user is looking at', () => {
  // The bug this prevents: an agent called go_back and reload_tab with no
  // tab_id, which resolved to whatever tab was active, and really navigated it.
  it('the script preamble guards the active-tab fallback behind a flag', () => {
    assert.match(
      PREAMBLE,
      /if \(P\.allow_active_tab\) return mainWindow\(\)\.activeTab;/,
      'the active-tab fallback is no longer gated'
    );
    assert.match(PREAMBLE, /NO_TARGET_TAB/, 'a refused resolution has no sentinel to report');
  });

  it('explains the refusal in terms of what the caller should pass instead', () => {
    const message = friendly('Error: NO_TARGET_TAB (-2700)');
    assert.match(message, /tab_id/, 'does not say to pass a tab_id');
    assert.match(message, /open_url/, 'does not offer the other way to get a tab');
    assert.match(message, /user/, 'does not explain whose tab it is protecting');
  });

  it('passes the flag out of band, never as a caller-visible argument', () => {
    const withFlag = scoped({ tab_id: 'abc', __allowActiveTab: true });
    assert.equal(withFlag.allow_active_tab, true);
    assert.equal(withFlag.__allowActiveTab, undefined, 'the private key leaked into the script params');

    const withoutFlag = scoped({ tab_id: 'abc' });
    assert.equal(withoutFlag.allow_active_tab, false, 'the fallback must default to refused');
  });
});
