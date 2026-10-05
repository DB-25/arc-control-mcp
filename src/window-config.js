// How agent tabs are kept out of the user's way. Parsed from the environment
// once at startup, but written as pure functions so the parsing is testable.

export const WINDOW_MODES = ['dedicated', 'space'];
export const PLACEMENTS = ['auto', 'second-display', 'minimized', 'none'];

export const DEFAULT_WINDOW_MODE = 'dedicated';
export const DEFAULT_PLACEMENT = 'auto';

function parseChoice(name, raw, allowed, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: fallback };
  const value = String(raw).trim().toLowerCase();
  if (allowed.includes(value)) return { value };
  // A typo must not stop the server from starting, and must not be silent
  // either: the fallback is reported in arc_status.
  return {
    value: fallback,
    warning: `${name}="${raw}" is not one of ${allowed.join(', ')}. Using "${fallback}".`
  };
}

/** Reads ARC_MCP_WINDOW and ARC_MCP_WINDOW_PLACEMENT. Invalid values fall back and say so. */
export function parseWindowConfig(env = process.env) {
  const mode = parseChoice('ARC_MCP_WINDOW', env.ARC_MCP_WINDOW, WINDOW_MODES, DEFAULT_WINDOW_MODE);
  const placement = parseChoice('ARC_MCP_WINDOW_PLACEMENT', env.ARC_MCP_WINDOW_PLACEMENT, PLACEMENTS, DEFAULT_PLACEMENT);
  return {
    mode: mode.value,
    placement: placement.value,
    warnings: [mode.warning, placement.warning].filter(Boolean)
  };
}

export const windowConfig = parseWindowConfig();
