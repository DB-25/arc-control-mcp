// Structural checks on the 26 tool definitions, the part a model reads before
// it ever calls anything. These assert shape, not wording: a reworded
// description should not fail a test, but a tool that quietly stops sharing the
// TAB_ID schema, or a selector that stops documenting "text=", should.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/registry.js';
import { TAB_ID, SELECTOR, VERBOSE } from '../src/tools/shared.js';

const SCHEMA_TYPES = ['string', 'boolean', 'number', 'object', 'array'];
// close_tab's "Close a tab." is the shortest real description, so anything
// under this is a stub rather than terse.
const MIN_DESCRIPTION_CHARS = 10;
const STUB = /^(todo|tbd|fixme|wip|xxx|placeholder)\b/i;

const propsOf = (tool) => tool.inputSchema.properties;
const toolsWith = (name) => TOOLS.filter((tool) => name in propsOf(tool));

describe('tool identity and description', () => {
  it('every tool name is snake_case, which is what the README and clients show', () => {
    for (const tool of TOOLS) {
      assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not snake_case`);
    }
  });

  it('no tool description is a stub', () => {
    for (const tool of TOOLS) {
      const text = tool.description.trim();
      assert.ok(text.length >= MIN_DESCRIPTION_CHARS, `${tool.name} description is too short to be real: ${text}`);
      assert.doesNotMatch(text, STUB, `${tool.name} description is a placeholder`);
    }
  });

  it('every tool carries the four MCP behaviour hints, so a client can gate on them', () => {
    for (const tool of TOOLS) {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} annotations.${hint} is not a boolean`);
      }
    }
  });

  it('no tool claims to be both read-only and destructive', () => {
    for (const tool of TOOLS) {
      const { readOnlyHint, destructiveHint } = tool.annotations;
      assert.ok(!(readOnlyHint && destructiveHint), `${tool.name} is both read-only and destructive`);
    }
  });
});

describe('shared argument schemas are actually shared', () => {
  it('at least the tools that need a tab take one', () => {
    // A tripwire on the sharing itself: if this drops to nothing, the checks
    // below stop checking anything.
    assert.ok(toolsWith('tab_id').length >= 20, `only ${toolsWith('tab_id').length} tools accept tab_id`);
    assert.ok(toolsWith('selector').length >= 6, `only ${toolsWith('selector').length} tools accept a selector`);
  });

  for (const tool of toolsWith('tab_id')) {
    it(`${tool.name} uses the shared TAB_ID schema shape`, () => {
      const schema = propsOf(tool).tab_id;
      // Some tools narrow the description (open_url, switch_to_tab, batch), so
      // the shape is what has to match: same keys, same type, never a new
      // required-ness or enum bolted on locally.
      assert.deepEqual(Object.keys(schema).sort(), Object.keys(TAB_ID).sort());
      assert.equal(schema.type, TAB_ID.type);
      assert.equal(typeof schema.description, 'string');
      assert.ok(schema.description.trim().length > 0);
    });
  }

  it('only switch_to_tab makes tab_id mandatory, since every other tool has a fallback', () => {
    // Omitting tab_id is the normal case: it resolves to this agent's current
    // tab, then to whatever is active. A new required tab_id would be a
    // usability regression, not just a schema change.
    const requiring = toolsWith('tab_id')
      .filter((tool) => (tool.inputSchema.required ?? []).includes('tab_id'))
      .map((tool) => tool.name);
    assert.deepEqual(requiring, ['switch_to_tab']);
  });

  for (const tool of toolsWith('selector')) {
    it(`${tool.name} documents the "text=" selector form`, () => {
      const schema = propsOf(tool).selector;
      assert.equal(schema.type, SELECTOR.type);
      assert.ok(
        schema.description.includes('text='),
        `${tool.name} takes a selector but never mentions text=, so a model will only ever send CSS`
      );
    });
  }

  for (const tool of toolsWith('verbose')) {
    it(`${tool.name} uses the shared VERBOSE schema`, () => {
      assert.deepEqual(propsOf(tool).verbose, VERBOSE);
    });
  }
});

describe('every declared argument is usable as written', () => {
  it('each property has a type a JSON Schema client understands', () => {
    for (const tool of TOOLS) {
      for (const [name, schema] of Object.entries(propsOf(tool))) {
        assert.ok(SCHEMA_TYPES.includes(schema.type), `${tool.name}.${name} has type ${schema.type}`);
      }
    }
  });

  it('each property has a description, since the argument name alone is rarely enough', () => {
    for (const tool of TOOLS) {
      for (const [name, schema] of Object.entries(propsOf(tool))) {
        assert.equal(typeof schema.description, 'string', `${tool.name}.${name} has no description`);
        assert.ok(schema.description.trim().length > 0, `${tool.name}.${name} has an empty description`);
      }
    }
  });

  it('each default matches the declared type, so a client can apply it as sent', () => {
    for (const tool of TOOLS) {
      for (const [name, schema] of Object.entries(propsOf(tool))) {
        if (schema.default === undefined) continue;
        const kind = schema.type === 'number' ? 'number' : schema.type === 'boolean' ? 'boolean' : 'string';
        if (schema.type === 'boolean' || schema.type === 'number' || schema.type === 'string') {
          assert.equal(typeof schema.default, kind, `${tool.name}.${name} default is not a ${kind}`);
        }
      }
    }
  });

  it('each enum default is one of the enum values', () => {
    for (const tool of TOOLS) {
      for (const [name, schema] of Object.entries(propsOf(tool))) {
        if (!schema.enum || schema.default === undefined) continue;
        assert.ok(schema.enum.includes(schema.default), `${tool.name}.${name} defaults outside its enum`);
      }
    }
  });

  it('required is a list of names, never a bare string', () => {
    for (const tool of TOOLS) {
      const required = tool.inputSchema.required;
      if (required === undefined) continue;
      assert.ok(Array.isArray(required), `${tool.name} required is not an array`);
      assert.ok(required.length > 0, `${tool.name} has an empty required array, which says nothing`);
      for (const name of required) assert.equal(typeof name, 'string');
    }
  });
});
