import { appendFileSync } from 'fs';

/**
 * Guardrails, applied once in the registry so every tool and every batch step
 * gets them without knowing they exist. Configuration is environment only, read
 * once at startup: an agent cannot loosen its own limits mid-session.
 *
 *   ARC_MCP_ALLOWED_ORIGINS  comma list; when set, only these origins may be touched
 *   ARC_MCP_BLOCKED_ORIGINS  comma list; these origins may not be touched (wins over allowed)
 *   ARC_MCP_BLOCK_READS=1    apply both lists to read tools too
 *   ARC_MCP_READ_ONLY=1      advertise and run only the read tools
 *   ARC_MCP_AUDIT_LOG=<path> append one JSON line per changing call
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const isOn = (value) => TRUTHY.has(String(value ?? '').trim().toLowerCase());

// Hosts are matched on the parsed hostname, never by substring, so
// "example.com.evil.test" cannot pass for "example.com".
const HOST_PATTERN = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?(\[[0-9a-f:.]+\]|[a-z0-9._-]+)?(?::(\d{1,5}))?$/i;
const SCHEME_ONLY = /^([a-z][a-z0-9+.-]*):$/i;
// Schemes whose URLs have a meaningful host. Anything else (about:, data:,
// chrome:) is opaque and can only be matched by naming its scheme.
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
const HOSTED = new Set(Object.keys(DEFAULT_PORTS));

/**
 * Parse one list entry. Forms: `example.com`, `*.example.com` (subdomains only,
 * so list the apex too), `https://example.com`, `localhost:3000`, `file://`
 * (any file: URL), `about:` (any about: URL). No port means any port, no scheme
 * means any scheme.
 */
export function parsePattern(raw, envName = 'origin list') {
  const text = String(raw).trim();
  const bad = () => new Error(
    `${envName} has an entry that is not an origin: "${text}". Use host, *.host, scheme://host[:port], file:// or about:. Paths are not supported.`
  );
  if (!text) throw bad();

  const schemeOnly = text.match(SCHEME_ONLY);
  if (schemeOnly) return { raw: text, scheme: `${schemeOnly[1].toLowerCase()}:`, host: null, wildcard: false, port: null };

  const match = text.match(HOST_PATTERN);
  if (!match) throw bad();
  const [, scheme, wildcard, host, port] = match;
  // "file://" has a scheme and no host, which means every file URL.
  if (!host && !(scheme && !wildcard && !port)) throw bad();
  if (wildcard && !host) throw bad();
  return {
    raw: text,
    scheme: scheme ? `${scheme.toLowerCase()}:` : null,
    host: host ? host.toLowerCase() : null,
    wildcard: !!wildcard,
    port: port || null
  };
}

export function parseList(value, envName) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parsePattern(entry, envName));
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Whether one parsed pattern covers a URL. */
export function matches(pattern, url) {
  const parsed = typeof url === 'string' ? parseUrl(url) : url;
  if (!parsed) return false;
  if (pattern.scheme && pattern.scheme !== parsed.protocol) return false;
  if (!pattern.host) return !!pattern.scheme;
  if (!HOSTED.has(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  const hostOk = pattern.wildcard ? host.endsWith(`.${pattern.host}`) : host === pattern.host;
  if (!hostOk) return false;
  // URL.port is empty for a scheme's default port, so a pattern naming it still matches.
  return !pattern.port || pattern.port === (parsed.port || DEFAULT_PORTS[parsed.protocol]);
}

/** Scheme plus host plus port: all an audit line or an error message ever shows of a URL. */
export function originOf(url) {
  const parsed = typeof url === 'string' ? parseUrl(url) : url;
  if (!parsed) return null;
  if (parsed.protocol === 'file:') return 'file://';
  if (!HOSTED.has(parsed.protocol)) return parsed.protocol;
  return `${parsed.protocol}//${parsed.host}`;
}

export function loadPolicy(env = process.env) {
  const allowed = parseList(env.ARC_MCP_ALLOWED_ORIGINS, 'ARC_MCP_ALLOWED_ORIGINS');
  const blocked = parseList(env.ARC_MCP_BLOCKED_ORIGINS, 'ARC_MCP_BLOCKED_ORIGINS');
  return {
    allowed,
    blocked,
    blockReads: isOn(env.ARC_MCP_BLOCK_READS),
    readOnly: isOn(env.ARC_MCP_READ_ONLY),
    auditLog: env.ARC_MCP_AUDIT_LOG ? String(env.ARC_MCP_AUDIT_LOG).trim() : null,
    hasOriginRules: allowed.length > 0 || blocked.length > 0
  };
}

/**
 * Null when the URL may be touched, otherwise the rule that stops it. A blocked
 * rule wins over an allowed one, and an unparseable or empty URL (a blank new
 * tab) passes a block list, since nothing can match it, but not an allow list.
 */
export function checkUrl(policy, url) {
  const parsed = parseUrl(url);
  const origin = parsed ? originOf(parsed) : null;
  for (const pattern of policy.blocked) {
    if (parsed && matches(pattern, parsed)) {
      return { rule: 'ARC_MCP_BLOCKED_ORIGINS', entry: pattern.raw, origin };
    }
  }
  if (policy.allowed.length > 0 && !(parsed && policy.allowed.some((pattern) => matches(pattern, parsed)))) {
    return { rule: 'ARC_MCP_ALLOWED_ORIGINS', entry: null, origin };
  }
  return null;
}

function violationMessage(violation, subject) {
  const where = violation.origin ? `${subject} ${violation.origin}` : `${subject} a page with no recognisable origin (blank, or still loading)`;
  if (violation.rule === 'ARC_MCP_BLOCKED_ORIGINS') {
    return `Blocked by ARC_MCP_BLOCKED_ORIGINS (rule "${violation.entry}"): ${where}.`;
  }
  return `Blocked by ARC_MCP_ALLOWED_ORIGINS: ${where} is not on the allow list.`;
}

// Arguments that carry what the user typed, the code they ran or a full URL
// (which may hold a token in its query). The audit log must never hold those,
// and an error message often quotes them back.
// A key combination can be a typed password character by character, and a
// dialog's prompt text is typed input too.
const SECRET_ARGS = ['value', 'text', 'code', 'option', 'url', 'key', 'prompt_text'];

function secretsOf(args) {
  const out = [];
  for (const key of SECRET_ARGS) if (typeof args?.[key] === 'string' && args[key]) out.push(args[key]);
  for (const field of Array.isArray(args?.fields) ? args.fields : []) {
    if (typeof field?.value === 'string' && field.value) out.push(field.value);
  }
  // Longest first, so a value that contains another is removed whole.
  return out.sort((a, b) => b.length - a.length);
}

// These tools take what the user typed or the code they ran, and a page error
// quotes fragments of both back ("ReferenceError in fetch(...)"), so no
// substitution can make their error text safe. They log that they failed, not why.
const VALUE_TOOLS = new Set([
  'fill', 'fill_form', 'type', 'select_option', 'execute_javascript', 'press_key',
  'trusted_type', 'trusted_press_key', 'upload_file', 'handle_dialog'
]);
const WITHHELD = 'failed; details withheld because this tool handles typed values or script code';

const AUDIT_ERROR_CHARS = 300;

export function scrub(message, args) {
  let text = String(message ?? '');
  for (const secret of secretsOf(args)) text = text.split(secret).join('[redacted]');
  return text.length > AUDIT_ERROR_CHARS ? `${text.slice(0, AUDIT_ERROR_CHARS)}...` : text;
}

/**
 * An audit file that cannot be written is a startup failure, not a silent gap:
 * someone who asked for a trail is relying on it.
 */
export function openAudit(path) {
  if (!path) return () => {};
  try {
    appendFileSync(path, '', { mode: 0o600 });
  } catch (error) {
    throw new Error(`ARC_MCP_AUDIT_LOG is not writable (${path}): ${error.message}`);
  }
  let warned = false;
  return (entry) => {
    try {
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      // stderr only: stdout is the MCP transport. Once, so a full disk does not flood it.
      if (!warned) console.error(`arc-control: could not append to the audit log ${path}: ${error.message}`);
      warned = true;
    }
  };
}

// Read once at startup. A typo in a rule crashes here with the variable named,
// which beats a guardrail that silently is not on.
export const POLICY = loadPolicy();

/** What arc_status tells the model about the limits it is running under. */
export function describePolicy(policy = POLICY) {
  return {
    readOnly: policy.readOnly,
    allowedOrigins: policy.allowed.map((p) => p.raw),
    blockedOrigins: policy.blocked.map((p) => p.raw),
    blockReads: policy.blockReads,
    audit: !!policy.auditLog
  };
}

const NAVIGATING = new Set(['open_url', 'go_back', 'go_forward', 'reload_tab']);

/**
 * Wrap a validated handler. `tab` resolves a call's target tab to { id, url }
 * exactly as the handler will, so the check and the action hit the same tab.
 * Only built when origin rules apply, because each resolution costs an osascript call.
 */
export function createGuard(policy, { resolveTab, audit = () => {}, now = () => new Date() } = {}) {
  const gateAllReads = policy.blockReads;

  return function guard(tool, handler) {
    const { readOnlyHint, openWorldHint } = tool.annotations;
    const isRead = readOnlyHint === true;
    // A read that must still resolve like a changing tool (see registry.js).
    const mayUseActiveTab = isRead && tool.ownTabOnly !== true;
    // batch checks nothing itself: its steps go through the wrapped handlers and
    // are checked, and logged, one by one.
    const isBatch = tool.name === 'batch';
    // openWorld marks the tools that touch a web page. The rest only handle Arc's own bookkeeping.
    const touchesPage = openWorldHint === true && !isBatch;
    const gated = policy.hasOriginRules && touchesPage && (!isRead || gateAllReads);
    const audited = !isRead && !isBatch;

    const auditError = (args, outcome) =>
      VALUE_TOOLS.has(tool.name) && !outcome.ours ? WITHHELD : scrub(outcome.error, args);

    const finish = (args, outcome) => {
      if (!audited) return;
      const tab = outcome.result?.tab;
      audit({
        time: now().toISOString(),
        tool: tool.name,
        tab: tab?.id ?? outcome.tabId ?? args.tab_id ?? null,
        origin: outcome.origin ?? originOf(tab?.url) ?? null,
        ok: outcome.ok,
        error: outcome.ok ? null : auditError(args, outcome)
      });
    };

    return async (args = {}, extra) => {
      let tabId = null;
      let origin = null;
      let nextArgs = args;
      try {
        if (tool.name === 'open_url') {
          const violation = checkUrl(policy, args.url);
          origin = originOf(args.url);
          if (violation) {
            const result = { ok: false, blocked: true, rule: violation.rule, error: `${violationMessage(violation, 'open_url would load')} Nothing was opened.` };
            finish(args, { ok: false, error: result.error, origin, ours: true });
            return result;
          }
        } else if (gated) {
          const peeked = await resolveTab(args, mayUseActiveTab);
          tabId = peeked.id;
          origin = originOf(peeked.url);
          const violation = checkUrl(policy, peeked.url);
          if (violation) {
            const result = { ok: false, blocked: true, rule: violation.rule, error: `${violationMessage(violation, `${tool.name} would act on`)} Nothing was done.`, tab: { id: peeked.id, origin } };
            finish(args, { ok: false, error: result.error, tabId, origin, ours: true });
            return result;
          }
          // Pin the tab we just vetted, so a user switching tabs between the
          // check and the action cannot redirect a no-tab_id call.
          if (!args.tab_id) nextArgs = { ...args, tab_id: peeked.id };
        }

        let result = await handler(nextArgs, extra);

        // A redirect can land a navigation on a blocked origin after the target
        // check passed. The navigation happened, so say that instead of ok.
        if (policy.hasOriginRules && NAVIGATING.has(tool.name) && result?.tab?.url) {
          const landed = checkUrl(policy, result.tab.url);
          if (landed) {
            result = {
              ...result,
              ok: false,
              blocked: true,
              rule: landed.rule,
              error: `${violationMessage(landed, `${tool.name} finished, but the tab is now on`)} The target passed the check and a redirect or the page itself moved it. Close the tab or navigate it somewhere allowed.`
            };
          }
        }
        const failed = !result || result.ok === false || (result.ok === undefined && typeof result.error === 'string');
        finish(args, { ok: !failed, error: result?.error, result, tabId, origin, ours: result?.blocked === true });
        return result;
      } catch (error) {
        finish(args, { ok: false, error: error.message, tabId, origin });
        throw error;
      }
    };
  };
}

/** What a read-only server says when a changing tool is called anyway. */
export function readOnlyRefusal(toolName) {
  return {
    ok: false,
    blocked: true,
    rule: 'ARC_MCP_READ_ONLY',
    error: `${toolName} changes things, and this server runs with ARC_MCP_READ_ONLY=1, so only read tools work. Nothing was done.`
  };
}
