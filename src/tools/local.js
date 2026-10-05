import { runJxa } from '../jxa.js';
import { z } from './schema.js';
import { read } from './shared.js';
import {
  FRESHNESS_NOTE,
  LocalDataError,
  findSpace,
  isoOrNull,
  loadArchive,
  loadSidebar,
  termsOf,
  walkTabs
} from '../arc-data.js';
import { HISTORY_OPT_IN_ERROR, historyAllowed, queryHistory } from '../arc-history.js';

const MS_PER_DAY = 86400000;
const MAX_TREE_ITEMS = 2000;
const MAX_LIST_ITEMS = 500;
const MAX_WINDOW_DAYS = 3650;
const MAX_DUPLICATE_GROUPS = 50;

const SPACE_PARAM = z.string().describe('Only this space, by id or title from list_spaces');
const LIMIT = (defaultValue, max, noun) =>
  z.number().min(1).max(max).default(defaultValue).describe(`Maximum ${noun} to return. Capped at ${max}.`);

export const tools = [
  {
    name: 'sidebar_tree',
    description:
      "Read Arc's sidebar from its own data file: every space with its pinned items (folders nested) and unpinned tabs, plus the top-app favourites. Gives what list_tabs cannot (pinned versus unpinned, folders, when each tab was last active) in milliseconds, without driving Arc. Each tab's id is the tab_id list_tabs reports, so it can be passed to other tools. Arc writes the file periodically, so recent changes may be missing: see asOf. Pass match_live to check each tab against Arc's open tabs.",
    input: z.object({
      space: SPACE_PARAM.optional(),
      max_items: LIMIT(200, MAX_TREE_ITEMS, 'tabs'),
      include_urls: z.boolean().default(true).describe('Include each tab\'s url. Turn off for a smaller, less sensitive result.'),
      match_live: z
        .boolean()
        .default(false)
        .describe("Also ask Arc which tabs are open and mark each one live: true or false. Costs an Apple Events call and needs Arc running.")
    }),
    annotations: read('Sidebar Tree', { openWorld: false })
  },
  {
    name: 'find_stale_tabs',
    description:
      "Find tabs the user has not touched for a number of days, oldest first, with their space and whether they are pinned, unpinned or a top app. Also reports exact duplicate URLs across the whole sidebar. Read from Arc's own data file, so it needs no Apple Events. To act on a result, pass its id to close_tab.",
    input: z.object({
      days: z.number().min(0).max(MAX_WINDOW_DAYS).default(7).describe('Idle for at least this many days'),
      space: SPACE_PARAM.optional(),
      limit: LIMIT(50, MAX_LIST_ITEMS, 'stale tabs'),
      include_duplicates: z.boolean().default(true).describe('Also report URLs open in more than one tab')
    }),
    annotations: read('Find Stale Tabs', { openWorld: false })
  },
  {
    name: 'search_archive',
    description:
      "Search tabs Arc archived or the user closed (the sidebar's Archive), by text in the title or url, newest first. Every word in query must match. Read from Arc's own data file. Use reason 'auto' to see only what Arc archived on its own.",
    input: z.object({
      query: z.string().describe('Words to find in the title or url, case-insensitive. Empty lists the newest archived tabs.').default(''),
      reason: z.enum(['any', 'auto', 'manual']).default('any').describe("'auto' is archived by Arc after inactivity, 'manual' is closed by the user"),
      since_days: z.number().min(0).max(MAX_WINDOW_DAYS).describe('Only tabs archived within this many days').optional(),
      limit: LIMIT(25, MAX_LIST_ITEMS, 'archived tabs')
    }),
    annotations: read('Search Archive', { openWorld: false })
  },
  {
    name: 'search_history',
    description:
      "Search Arc's browsing history (pages visited, with visit counts and last visit time) by text in the title or url, newest first. Browsing history is sensitive, so this is OFF unless the server was started with ARC_MCP_ALLOW_HISTORY=1; otherwise it returns ok: false saying how to enable it. Every word in query must match.",
    input: z.object({
      query: z.string().describe('Words to find in the title or url, case-insensitive. Empty lists the most recent pages.').default(''),
      since_days: z.number().min(0).max(MAX_WINDOW_DAYS).default(30).describe('Window start, in days ago'),
      until_days: z.number().min(0).max(MAX_WINDOW_DAYS).default(0).describe('Window end, in days ago. 0 means now.'),
      limit: LIMIT(25, MAX_LIST_ITEMS, 'pages'),
      profile: z
        .string()
        .regex(/^(?!\.+$)[A-Za-z0-9 _.-]+$/, 'a profile folder name such as "Default" or "Profile 1"')
        .default('Default')
        .describe('The Arc profile folder under "User Data"')
    }),
    annotations: read('Search History', { openWorld: false })
  }
];

/** Every handler turns a data problem into ok: false, never a thrown stack. */
function guarded(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      if (error instanceof LocalDataError) return { ok: false, error: error.message };
      throw error;
    }
  };
}

function resolveSpace(model, query) {
  if (!query) return null;
  const space = findSpace(model, query);
  if (!space) {
    const known = model.spaces.map((s) => s.title ?? s.id).join(', ');
    throw new LocalDataError(`No space matches "${query}". Spaces in the sidebar: ${known || 'none'}.`);
  }
  return space;
}

/** Public shape of a node, trimmed to a tab budget shared across the whole tree. */
function shape(nodes, budget, { includeUrls, liveIds }) {
  const out = [];
  for (const node of nodes) {
    if (node.kind === 'folder') {
      if (budget.left <= 0) break;
      out.push({ kind: 'folder', id: node.id, title: node.title, children: shape(node.children, budget, { includeUrls, liveIds }) });
      continue;
    }
    if (budget.left <= 0) break;
    budget.left -= 1;
    out.push({
      kind: 'tab',
      id: node.id,
      title: node.title,
      ...(includeUrls ? { url: node.url } : {}),
      lastActiveAt: isoOrNull(node.lastActiveMs),
      ...(liveIds ? { live: liveIds.has(node.id) } : {})
    });
  }
  return out;
}

/** Ask Arc which tabs are open. A failure degrades to a note: the file data is still good. */
async function openTabIds() {
  try {
    const ids = await runJxa('requireArc(); JSON.stringify(snapshot().map(function (t) { return t.id; }));', {});
    return { ids: new Set(ids) };
  } catch (error) {
    return { error: error.message };
  }
}

async function sidebarTree({ space, max_items, include_urls, match_live }) {
  const { model, asOf } = await loadSidebar();
  const only = resolveSpace(model, space);
  const live = match_live ? await openTabIds() : {};
  const budget = { left: max_items };
  const options = { includeUrls: include_urls, liveIds: live.ids };

  const selected = only ? [only] : model.spaces;
  const spaces = selected.map((s) => ({
    id: s.id,
    title: s.title,
    pinned: shape(s.pinned, budget, options),
    unpinned: shape(s.unpinned, budget, options)
  }));
  // Top apps belong to no space, so a space filter leaves them out.
  const topApps = only ? [] : shape(model.topApps, budget, options);

  const roots = [...selected.flatMap((s) => [s.pinned, s.unpinned]), ...(only ? [] : [model.topApps])];
  const total = [...walkTabs(model, only)].length;
  const returned = max_items - budget.left;
  const sidebarIds = new Set([...walkTabs(model)].map((t) => t.node.id));
  return {
    ok: true,
    asOf,
    note: FRESHNESS_NOTE,
    totalTabs: total,
    returnedTabs: returned,
    truncated: returned < total,
    ...(live.ids ? { openTabsNotInSidebarFile: [...live.ids].filter((id) => !sidebarIds.has(id)).length } : {}),
    ...(live.error ? { liveError: `Could not check open tabs: ${live.error}` } : {}),
    folderCount: roots.reduce((n, nodes) => n + countFolders(nodes), 0),
    spaces,
    topApps
  };
}

function countFolders(nodes) {
  return nodes.reduce((sum, n) => (n.kind === 'folder' ? sum + 1 + countFolders(n.children) : sum), 0);
}

/** Groups of tabs sharing an identical url, biggest first. Matching is exact on purpose. */
function duplicateGroups(model) {
  const byUrl = new Map();
  for (const entry of walkTabs(model)) {
    const url = entry.node.url;
    if (!url) continue;
    byUrl.set(url, [...(byUrl.get(url) ?? []), entry]);
  }
  return [...byUrl.entries()]
    .filter(([, entries]) => entries.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([url, entries]) => ({
      url,
      count: entries.length,
      tabs: entries.map((e) => ({ id: e.node.id, title: e.node.title, space: e.space, location: e.location }))
    }));
}

async function findStaleTabs({ days, space, limit, include_duplicates }) {
  const { model, asOf } = await loadSidebar();
  const only = resolveSpace(model, space);
  const now = Date.now();
  const cutoff = now - days * MS_PER_DAY;

  const all = [...walkTabs(model, only)];
  const stale = all
    .filter((e) => e.node.lastActiveMs !== null && e.node.lastActiveMs <= cutoff)
    .sort((a, b) => a.node.lastActiveMs - b.node.lastActiveMs);
  const groups = include_duplicates ? duplicateGroups(model) : [];
  const duplicateIds = new Set(groups.flatMap((g) => g.tabs.map((t) => t.id)));

  return {
    ok: true,
    asOf,
    note: FRESHNESS_NOTE,
    days,
    totalTabs: all.length,
    // A tab with no recorded activity time cannot be called stale or fresh.
    unknownActivity: all.filter((e) => e.node.lastActiveMs === null).length,
    staleCount: stale.length,
    truncated: stale.length > limit,
    stale: stale.slice(0, limit).map((e) => ({
      id: e.node.id,
      title: e.node.title,
      url: e.node.url,
      space: e.space,
      location: e.location,
      ...(e.folderPath.length ? { folder: e.folderPath.join(' / ') } : {}),
      lastActiveAt: isoOrNull(e.node.lastActiveMs),
      idleDays: Math.floor((now - e.node.lastActiveMs) / MS_PER_DAY),
      ...(include_duplicates ? { isDuplicate: duplicateIds.has(e.node.id) } : {})
    })),
    ...(include_duplicates
      ? {
          duplicateUrlCount: groups.length,
          duplicates: groups.slice(0, MAX_DUPLICATE_GROUPS)
        }
      : {})
  };
}

const matchesAll = (terms, ...fields) => {
  const haystack = fields.filter(Boolean).join('\n').toLowerCase();
  return terms.every((term) => haystack.includes(term));
};

async function searchArchive({ query, reason, since_days, limit }) {
  const { entries, asOf } = await loadArchive();
  const terms = termsOf(query);
  const cutoff = since_days === undefined ? null : Date.now() - since_days * MS_PER_DAY;

  // Space titles are a convenience: a missing or unreadable sidebar must not sink the search.
  let titleById = new Map();
  try {
    const { model } = await loadSidebar();
    titleById = new Map(model.spaces.map((s) => [s.id, s.title]));
  } catch { /* ids still identify the space */ }

  const matched = entries
    .filter((e) => reason === 'any' || e.reason === reason)
    .filter((e) => cutoff === null || (e.archivedMs !== null && e.archivedMs >= cutoff))
    .filter((e) => matchesAll(terms, e.title, e.url))
    .sort((a, b) => (b.archivedMs ?? 0) - (a.archivedMs ?? 0));

  return {
    ok: true,
    asOf,
    note: FRESHNESS_NOTE,
    archiveSize: entries.length,
    matchCount: matched.length,
    truncated: matched.length > limit,
    results: matched.slice(0, limit).map((e) => ({
      title: e.title,
      url: e.url,
      archivedAt: isoOrNull(e.archivedMs),
      lastActiveAt: isoOrNull(e.lastActiveMs),
      reason: e.reason,
      from: e.sourceKind,
      ...(e.sourceSpaceId ? { space: titleById.get(e.sourceSpaceId) ?? e.sourceSpaceId } : {})
    }))
  };
}

async function searchHistory({ query, since_days, until_days, limit, profile }) {
  if (!historyAllowed()) return { ok: false, error: HISTORY_OPT_IN_ERROR };
  if (until_days > since_days) {
    return { ok: false, error: `until_days (${until_days}) is later than since_days (${since_days}), so the window is empty. since_days is how far back it starts.` };
  }
  const { asOf, truncated, rows } = await queryHistory({
    profile,
    terms: termsOf(query),
    sinceDays: since_days,
    untilDays: until_days,
    limit
  });
  return {
    ok: true,
    asOf,
    note: `${FRESHNESS_NOTE} History is read from a temporary copy that is deleted afterwards.`,
    window: { sinceDays: since_days, untilDays: until_days },
    truncated,
    results: rows
  };
}

export const handlers = {
  sidebar_tree: guarded(sidebarTree),
  find_stale_tabs: guarded(findStaleTabs),
  search_archive: guarded(searchArchive),
  search_history: guarded(searchHistory)
};
