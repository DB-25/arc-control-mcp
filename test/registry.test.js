// The registry is the server's startup guard: a malformed tool is invisible
// over MCP, so registry.js validates every tool at import and crashes with the
// offending module named. Two halves here: the real registry passes, and the
// validator really does reject the shapes it claims to.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { TOOLS, HANDLERS, MODULE_NAMES } from '../src/registry.js';

// Counts are a deliberate tripwire: the README, --help output and CHANGELOG all
// quote them, so a tool added or dropped without updating them fails here.
const EXPECTED_TOOLS = 30;
const EXPECTED_MODULES = ['tabs', 'navigation', 'content', 'interact', 'spaces', 'scripting', 'local'];

const SRC_DIR = new URL('../src/', import.meta.url);
const temps = [];

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * Import a private copy of src/ with one tool module replaced, so the real
 * validator in registry.js runs against a deliberately broken module. Copying
 * rather than patching keeps src/ untouched, and a fresh directory per case
 * keeps ESM's module cache from serving an earlier copy.
 */
async function importRegistryWith(moduleFile, source) {
  const dir = mkdtempSync(join(tmpdir(), 'arc-registry-'));
  // src/registry.js imports zod by bare specifier. A temp dir outside the repo
  // has nothing to resolve it against, so lend it the real node_modules.
  try {
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'node_modules'), 'dir');
  } catch {
    // A platform without symlink permission can fall back to no link: the
    // import will fail loudly rather than silently passing.
  }
  temps.push(dir);
  cpSync(SRC_DIR, join(dir, 'src'), { recursive: true });
  if (moduleFile) writeFileSync(join(dir, 'src', 'tools', moduleFile), source);
  return import(pathToFileURL(join(dir, 'src', 'registry.js')).href);
}

/**
 * A module the validator should accept, used as the base for each broken
 * variant. `input` is emitted as source rather than JSON, because a Zod schema
 * is a live object and cannot be serialised into a generated module.
 */
const fakeModule = (tool, handlerName = tool.name) => {
  const { input = GOOD_INPUT_SOURCE, ...rest } = tool;
  return `
import { z } from 'zod';
export const tools = [{ ...${JSON.stringify(rest)}, input: ${input} }];
export const handlers = { ${JSON.stringify(handlerName)}: async () => ({ ok: true }) };
`;
};

const GOOD_INPUT_SOURCE = "z.object({ thing: z.string().describe('A thing').optional() })";

const GOOD_TOOL = {
  name: 'fake_tool',
  description: 'A syntactically valid tool used to prove the harness itself is sound.',
  annotations: { title: 'Fake Tool' }
};

describe('the shipped registry', () => {
  it(`exposes exactly ${EXPECTED_TOOLS} tools from ${EXPECTED_MODULES.length} modules`, () => {
    assert.equal(TOOLS.length, EXPECTED_TOOLS);
    assert.equal(MODULE_NAMES.length, EXPECTED_MODULES.length);
    assert.deepEqual([...MODULE_NAMES].sort(), [...EXPECTED_MODULES].sort());
  });

  it('has no duplicate tool names', () => {
    const names = TOOLS.map((tool) => tool.name);
    const seen = new Set(names);
    assert.equal(seen.size, names.length, `duplicates: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('has a handler for every tool', () => {
    for (const tool of TOOLS) {
      assert.equal(typeof HANDLERS[tool.name], 'function', `${tool.name} has no callable handler`);
    }
  });

  it('has a tool for every handler', () => {
    const names = new Set(TOOLS.map((tool) => tool.name));
    for (const name of Object.keys(HANDLERS)) {
      assert.ok(names.has(name), `handler ${name} is not reachable: no tool declares it`);
    }
  });

  it('gives every tool a non-empty description', () => {
    for (const tool of TOOLS) {
      assert.equal(typeof tool.description, 'string', `${tool.name} description is not a string`);
      assert.ok(tool.description.trim().length > 0, `${tool.name} has an empty description`);
    }
  });

  it('gives every tool an object inputSchema with a properties map', () => {
    for (const tool of TOOLS) {
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} inputSchema is not an object schema`);
      assert.equal(typeof tool.inputSchema.properties, 'object', `${tool.name} has no properties map`);
      assert.notEqual(tool.inputSchema.properties, null);
    }
  });

  it('declares every required argument in properties', () => {
    for (const tool of TOOLS) {
      for (const name of tool.inputSchema.required ?? []) {
        assert.ok(name in tool.inputSchema.properties, `${tool.name} requires "${name}" but never declares it`);
      }
    }
  });

  it('gives every tool an annotations.title', () => {
    for (const tool of TOOLS) {
      assert.equal(typeof tool.annotations?.title, 'string', `${tool.name} has no annotations.title`);
      assert.ok(tool.annotations.title.trim().length > 0, `${tool.name} has an empty annotations.title`);
    }
  });
});

describe('the registry validator rejects malformed tools at import', () => {
  it('accepts an unmodified copy of src, so a rejection below is never the harness', () => {
    // Positive control. Without it, a broken copy mechanism would look like a
    // working validator on every case that follows.
    return importRegistryWith(null).then((registry) => {
      assert.equal(registry.TOOLS.length, EXPECTED_TOOLS);
    });
  });

  it('accepts a well formed fake module, so each rejection below is about the defect', async () => {
    const registry = await importRegistryWith('spaces.js', fakeModule(GOOD_TOOL));
    assert.equal(registry.TOOLS.some((tool) => tool.name === 'fake_tool'), true);
    // spaces.js contributed two tools; the fake contributes one.
    assert.equal(registry.TOOLS.length, EXPECTED_TOOLS - 1);
  });

  it('rejects a tool with no description, naming the module and the tool', async () => {
    await assert.rejects(
      () => importRegistryWith('spaces.js', fakeModule({ ...GOOD_TOOL, description: '   ' })),
      /spaces\.fake_tool has no description/
    );
  });

  it('rejects a nameless tool, though the handler parity check gets there first', async () => {
    // validate() has its own "tool with no name" message, but the loop looks the
    // handler up by name before calling it, so a nameless tool is caught as a
    // missing handler. It is still rejected, which is what matters at startup.
    const { description, annotations } = GOOD_TOOL;
    await assert.rejects(
      () => importRegistryWith('spaces.js', fakeModule({ description, annotations }, 'fake_tool')),
      /declares undefined with no handler/
    );
  });

  it('rejects a tool with no input schema at all', async () => {
    await assert.rejects(
      () => importRegistryWith('spaces.js', fakeModule({ ...GOOD_TOOL, input: 'undefined' })),
      /needs an "input" Zod schema/
    );
  });

  it('rejects an input schema that is not a z.object, so arguments stay named', async () => {
    await assert.rejects(
      () => importRegistryWith('spaces.js', fakeModule({ ...GOOD_TOOL, input: 'z.string()' })),
      /must be a z\.object/
    );
  });

  it('rejects an input that is a plain JSON Schema rather than a Zod schema', async () => {
    // The old hand-written form. It has no safeParse, so nothing would validate
    // arguments, which is the whole point of generating the schema from Zod.
    await assert.rejects(
      () =>
        importRegistryWith(
          'spaces.js',
          fakeModule({ ...GOOD_TOOL, input: "{ type: 'object', properties: {} }" })
        ),
      /needs an "input" Zod schema/
    );
  });

  it('rejects a tool with no annotations.title', async () => {
    await assert.rejects(
      () => importRegistryWith('spaces.js', fakeModule({ ...GOOD_TOOL, annotations: { readOnlyHint: true } })),
      /spaces\.fake_tool has no annotations\.title/
    );
  });

  it('rejects a tool name that another module already used', async () => {
    // tabs.js is registered before spaces.js, so the clash is caught here.
    await assert.rejects(
      () => importRegistryWith('spaces.js', fakeModule({ ...GOOD_TOOL, name: 'list_tabs' })),
      /Duplicate tool name list_tabs in module spaces/
    );
  });

  it('rejects a tool with no handler', async () => {
    await assert.rejects(
      () => importRegistryWith('spaces.js', fakeModule(GOOD_TOOL, 'some_other_name')),
      /declares fake_tool with no handler/
    );
  });

  it('rejects a handler with no tool definition, which would be dead code', async () => {
    const source = `${fakeModule(GOOD_TOOL)}\nhandlers.orphan_handler = async () => ({});\n`;
    await assert.rejects(
      () => importRegistryWith('spaces.js', source),
      /has handler orphan_handler with no tool definition/
    );
  });
});
