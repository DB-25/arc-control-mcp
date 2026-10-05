import { toJSONSchema } from 'zod';

import { ArcError } from './jxa.js';
import * as tabs from './tools/tabs.js';
import * as navigation from './tools/navigation.js';
import * as content from './tools/content.js';
import * as interact from './tools/interact.js';
import * as spaces from './tools/spaces.js';
import * as scripting from './tools/scripting.js';
import * as wait from './tools/wait.js';
import * as input from './tools/input.js';
import { POLICY, createGuard, openAudit, readOnlyRefusal } from './policy.js';
import { peekTab } from './tools/shared.js';

// Drop a module in here and its tools are exposed; nothing else needs changing.
const MODULES = { tabs, navigation, content, interact, spaces, scripting, wait, input };

export const TOOLS = [];
export const HANDLERS = {};

// An unwritable audit file crashes here too, with the variable named.
const guard = createGuard(POLICY, { resolveTab: peekTab, audit: openAudit(POLICY.auditLog) });

// A malformed tool definition is invisible over MCP: the client just sees a
// tool that behaves oddly. Failing at import turns that into a startup crash
// with the offending module named.
/**
 * The wire schema is generated, never hand-written. `io: 'input'` is what keeps
 * a field with a default out of `required`, and drops the blanket
 * additionalProperties so a tool can opt into it with z.strictObject.
 */
function schemaFrom(input) {
  const json = toJSONSchema(input, { io: 'input' });
  // $schema is meaningful for a standalone document, not for an inputSchema.
  delete json.$schema;
  return json;
}

function readableIssues(error) {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function validate(moduleName, tool) {
  const where = `${moduleName}.${tool?.name ?? '<unnamed>'}`;
  if (!tool?.name) throw new Error(`Module ${moduleName} has a tool with no name`);
  if (typeof tool.description !== 'string' || !tool.description.trim()) {
    throw new Error(`Tool ${where} has no description, so a model cannot tell when to call it`);
  }
  if (!tool.input || typeof tool.input.safeParse !== 'function') {
    throw new Error(`Tool ${where} needs an "input" Zod schema (see src/tools/schema.js)`);
  }
  const json = schemaFrom(tool.input);
  if (json.type !== 'object' || !json.properties) {
    throw new Error(`Tool ${where}'s input must be a z.object, so its schema describes named arguments`);
  }
  if (!tool.annotations?.title) {
    throw new Error(`Tool ${where} has no annotations.title`);
  }
  return json;
}

/**
 * One wrapper carries both cross-cutting concerns, so `batch` gets them for its
 * steps too: arguments are validated against the tool's own schema, and the
 * tool's read-only hint decides whether resolving to the user's active tab is
 * acceptable.
 */
function wrap(tool, handler) {
  const allowActiveTab = tool.annotations.readOnlyHint === true;
  return async (args = {}, extra) => {
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) {
      // A bad argument is the tool failing, not the protocol failing, so this
      // surfaces as an isError result the model can read and correct.
      throw new ArcError(`Invalid arguments for ${tool.name}. ${readableIssues(parsed.error)}`);
    }
    return handler({ ...parsed.data, __allowActiveTab: allowActiveTab }, extra);
  };
}

for (const [name, module] of Object.entries(MODULES)) {
  for (const tool of module.tools) {
    if (HANDLERS[tool.name]) throw new Error(`Duplicate tool name ${tool.name} in module ${name}`);
    if (!module.handlers[tool.name]) throw new Error(`Module ${name} declares ${tool.name} with no handler`);
    const inputSchema = validate(name, tool);
    // Display precedence is top-level title, then annotations.title, then name.
    // Deriving it here beats repeating the same string on 26 tool definitions.
    const { input, ...rest } = tool;
    // Read-only mode hides every changing tool from tools/list, and still
    // answers a call to one by name, so a client with a stale list gets a clear
    // refusal rather than "Unknown tool".
    if (POLICY.readOnly && tool.annotations.readOnlyHint !== true) {
      HANDLERS[tool.name] = async () => readOnlyRefusal(tool.name);
      continue;
    }
    TOOLS.push({ ...rest, title: tool.title ?? tool.annotations.title, inputSchema });
    HANDLERS[tool.name] = wrap(tool, guard(tool, module.handlers[tool.name]));
  }
  for (const handlerName of Object.keys(module.handlers)) {
    if (!module.tools.some((t) => t.name === handlerName)) {
      throw new Error(`Module ${name} has handler ${handlerName} with no tool definition`);
    }
  }
}

scripting.bindRegistry(() => HANDLERS);

export const MODULE_NAMES = Object.keys(MODULES);
