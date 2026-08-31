// The advertised tool surface is a contract with every client. A schema that
// changes by accident, for example because a shared primitive was edited or a
// zod upgrade renders differently, breaks callers silently. This pins it.
//
// When a change IS intended, regenerate the fixture in the same commit:
//   node -e "import('./src/registry.js').then(m => require('fs').writeFileSync('test/fixtures/tools-snapshot.json', JSON.stringify(m.TOOLS.map(t => ({name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations})), null, 2) + '\n'))"
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TOOLS } from '../src/registry.js';

const snapshot = JSON.parse(
  readFileSync(new URL('./fixtures/tools-snapshot.json', import.meta.url), 'utf8')
);

/** Key order is not part of the contract, so compare content only. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])])
  );
}

const live = TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: t.annotations
}));

describe('the advertised tool surface matches its snapshot', () => {
  it('exposes exactly the snapshotted tool names, in the same order', () => {
    assert.deepEqual(
      live.map((t) => t.name),
      snapshot.map((t) => t.name),
      'a tool was added, removed or reordered. Ordering matters because clients cache tools/list.'
    );
  });

  for (const expected of snapshot) {
    it(`${expected.name} advertises an unchanged schema, title and annotations`, () => {
      const actual = live.find((t) => t.name === expected.name);
      assert.ok(actual, `${expected.name} is gone from the registry`);
      assert.deepEqual(
        sortKeys(actual),
        sortKeys(expected),
        `${expected.name}'s advertised surface changed. If that was intended, regenerate test/fixtures/tools-snapshot.json in the same commit and say why.`
      );
    });
  }
});
