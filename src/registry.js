import * as tabs from './tools/tabs.js';
import * as navigation from './tools/navigation.js';
import * as content from './tools/content.js';
import * as interact from './tools/interact.js';
import * as spaces from './tools/spaces.js';
import * as scripting from './tools/scripting.js';

// Drop a module in here and its tools are exposed; nothing else needs changing.
const MODULES = { tabs, navigation, content, interact, spaces, scripting };

export const TOOLS = [];
export const HANDLERS = {};

// A malformed tool definition is invisible over MCP: the client just sees a
// tool that behaves oddly. Failing at import turns that into a startup crash
// with the offending module named.
function validate(moduleName, tool) {
  const where = `${moduleName}.${tool?.name ?? '<unnamed>'}`;
  if (!tool?.name) throw new Error(`Module ${moduleName} has a tool with no name`);
  if (typeof tool.description !== 'string' || !tool.description.trim()) {
    throw new Error(`Tool ${where} has no description, so a model cannot tell when to call it`);
  }
  if (tool.inputSchema?.type !== 'object' || !tool.inputSchema.properties) {
    throw new Error(`Tool ${where} needs an inputSchema of type object with a properties map`);
  }
  for (const required of tool.inputSchema.required ?? []) {
    if (!(required in tool.inputSchema.properties)) {
      throw new Error(`Tool ${where} requires "${required}" but never declares it in properties`);
    }
  }
  if (!tool.annotations?.title) {
    throw new Error(`Tool ${where} has no annotations.title`);
  }
}

for (const [name, module] of Object.entries(MODULES)) {
  for (const tool of module.tools) {
    if (HANDLERS[tool.name]) throw new Error(`Duplicate tool name ${tool.name} in module ${name}`);
    if (!module.handlers[tool.name]) throw new Error(`Module ${name} declares ${tool.name} with no handler`);
    validate(name, tool);
    TOOLS.push(tool);
    HANDLERS[tool.name] = module.handlers[tool.name];
  }
  for (const handlerName of Object.keys(module.handlers)) {
    if (!module.tools.some((t) => t.name === handlerName)) {
      throw new Error(`Module ${name} has handler ${handlerName} with no tool definition`);
    }
  }
}

scripting.bindRegistry(() => HANDLERS);

export const MODULE_NAMES = Object.keys(MODULES);
