import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Arc's own bookkeeping files. They carry what Apple Events cannot report
 * (pinned versus unpinned, folders, last-active time, the archive), and reading
 * a file takes milliseconds where a tab-by-tab Apple Events walk takes seconds.
 *
 * Everything here is strictly read-only, and these files are the user's private
 * browsing data: nothing in this module logs a title or a URL.
 */

/** The only file format versions this was written against. Anything else is refused. */
export const SIDEBAR_VERSION = 1;
export const ARCHIVE_VERSION = 1;

/** Arc stores dates as seconds since 2001-01-01 (Cocoa), not the Unix epoch. */
const COCOA_EPOCH_OFFSET_S = 978307200;

export const FRESHNESS_NOTE =
  "Read from Arc's own files, which Arc writes periodically rather than on every change, so tabs opened, closed or moved in the last minute or so may be missing or stale.";

/** Why a data file could not be used. Carries a message written for the caller. */
export class LocalDataError extends Error {}

export function dataDir() {
  return process.env.ARC_MCP_ARC_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Arc');
}

const cocoaToMs = (seconds) =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? (seconds + COCOA_EPOCH_OFFSET_S) * 1000 : null;

export const isoOrNull = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read and parse one data file, with its modification time as the freshness marker. */
export async function readDataFile(name) {
  const path = join(dataDir(), name);
  let text;
  let info;
  try {
    [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new LocalDataError(
        `${name} was not found in ${dataDir()}. Arc keeps it there on macOS; if your data lives elsewhere set ARC_MCP_ARC_DATA_DIR.`
      );
    }
    throw new LocalDataError(`${name} could not be read (${error.code ?? error.message}).`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LocalDataError(`${name} is not valid JSON, so it may be mid-write. Try again in a moment.`);
  }
  return { json, asOf: info.mtime.toISOString() };
}

function checkVersion(json, expected, name) {
  if (json?.version !== expected) {
    throw new LocalDataError(
      `${name} is format version ${JSON.stringify(json?.version)}, but this server only understands version ${expected}. ` +
        'Arc changed its file format; update arc-control-mcp or report it.'
    );
  }
}

/** Arc interleaves ids and objects in one array: [id, {..}, id, {..}]. Keep the objects. */
const objectsOf = (list) => (Array.isArray(list) ? list.filter((entry) => isObject(entry) && typeof entry.id === 'string') : []);

/**
 * A container marker is the plain string "pinned" in containerIDs and an object
 * such as {pinned: {}} in newContainerIDs. Accept both so either survives.
 */
function markerOf(entry) {
  if (typeof entry === 'string') return entry;
  return isObject(entry) ? Object.keys(entry)[0] ?? null : null;
}

function containerIdsFor(space, wanted) {
  for (const list of [space.containerIDs, space.newContainerIDs]) {
    if (!Array.isArray(list)) continue;
    for (let i = 0; i + 1 < list.length; i += 1) {
      if (markerOf(list[i]) === wanted && typeof list[i + 1] === 'string') return list[i + 1];
    }
  }
  return null;
}

/**
 * Turn the sidebar file into a plain model: spaces with pinned and unpinned
 * trees, plus top apps. A tab is {kind:'tab'}, anything with children that is
 * not a tab is {kind:'folder'}.
 */
export function parseSidebar(json) {
  checkVersion(json, SIDEBAR_VERSION, 'StorableSidebar.json');
  const store = (json.sidebar?.containers ?? []).find((c) => isObject(c) && Array.isArray(c.items));
  if (!store || !Array.isArray(store.spaces)) {
    throw new LocalDataError('StorableSidebar.json has no sidebar items, so its layout is not the one this server understands.');
  }
  const items = new Map(objectsOf(store.items).map((item) => [item.id, item]));

  function buildNode(id, trail) {
    const item = items.get(id);
    // A dangling child id or a cycle is data Arc left behind, not a reason to fail.
    if (!item || trail.has(id)) return null;
    const tab = item.data?.tab;
    if (isObject(tab)) {
      return {
        kind: 'tab',
        id,
        title: typeof item.title === 'string' ? item.title : tab.savedTitle ?? null,
        url: typeof tab.savedURL === 'string' ? tab.savedURL : null,
        lastActiveMs: cocoaToMs(tab.timeLastActiveAt)
      };
    }
    const seen = new Set(trail).add(id);
    return {
      kind: 'folder',
      id,
      title: typeof item.title === 'string' ? item.title : null,
      children: childrenOf(item, seen)
    };
  }

  function childrenOf(item, trail) {
    const ids = Array.isArray(item?.childrenIds) ? item.childrenIds : [];
    return ids.map((id) => buildNode(id, trail)).filter(Boolean);
  }

  const containerChildren = (containerId) => (containerId ? childrenOf(items.get(containerId), new Set([containerId])) : []);

  const spaces = objectsOf(store.spaces).map((space) => ({
    id: space.id,
    title: typeof space.title === 'string' ? space.title : null,
    pinned: containerChildren(containerIdsFor(space, 'pinned')),
    unpinned: containerChildren(containerIdsFor(space, 'unpinned'))
  }));

  const topAppIds = (store.topAppsContainerIDs ?? []).filter((id) => typeof id === 'string');
  const topApps = topAppIds.flatMap((id) => containerChildren(id));
  return { spaces, topApps };
}

/** Every tab in the model with where it lives. Folders are walked, not returned. */
export function* walkTabs(model, onlySpace = null) {
  function* walk(nodes, space, location, path) {
    for (const node of nodes) {
      if (node.kind === 'tab') yield { node, space, location, folderPath: path };
      else yield* walk(node.children, space, location, [...path, node.title ?? '(untitled folder)']);
    }
  }
  for (const space of model.spaces) {
    if (onlySpace && space !== onlySpace) continue;
    yield* walk(space.pinned, space.title, 'pinned', []);
    yield* walk(space.unpinned, space.title, 'unpinned', []);
  }
  if (!onlySpace) yield* walk(model.topApps, null, 'topApp', []);
}

/** Match a space by id first, then by case-insensitive title. */
export function findSpace(model, query) {
  const lowered = query.trim().toLowerCase();
  return (
    model.spaces.find((space) => space.id === query) ??
    model.spaces.find((space) => (space.title ?? '').toLowerCase() === lowered) ??
    null
  );
}

export async function loadSidebar() {
  const { json, asOf } = await readDataFile('StorableSidebar.json');
  return { model: parseSidebar(json), asOf };
}

/** Archived tabs: auto-archived by Arc, or closed by hand (reason "manual"). */
export function parseArchive(json) {
  checkVersion(json, ARCHIVE_VERSION, 'StorableArchiveItems.json');
  if (!Array.isArray(json.items)) {
    throw new LocalDataError('StorableArchiveItems.json has no items array, so its layout is not the one this server understands.');
  }
  return json.items
    .filter((entry) => isObject(entry) && isObject(entry.sidebarItem))
    .map((entry) => {
      const item = entry.sidebarItem;
      const tab = item.data?.tab;
      const kind = isObject(entry.source) ? Object.keys(entry.source)[0] ?? 'unknown' : 'unknown';
      return {
        id: typeof item.id === 'string' ? item.id : null,
        title: typeof item.title === 'string' ? item.title : tab?.savedTitle ?? null,
        url: typeof tab?.savedURL === 'string' ? tab.savedURL : null,
        archivedMs: cocoaToMs(entry.archivedAt),
        lastActiveMs: cocoaToMs(tab?.timeLastActiveAt),
        reason: typeof entry.reason === 'string' ? entry.reason : 'unknown',
        sourceKind: kind,
        sourceSpaceId: entry.source?.[kind]?._0 ?? null
      };
    })
    // Folders and empty shells in the archive have nothing a caller could search.
    .filter((entry) => entry.url || entry.title);
}

export async function loadArchive() {
  const { json, asOf } = await readDataFile('StorableArchiveItems.json');
  return { entries: parseArchive(json), asOf };
}

/** Split a free-text query into lowercase terms that must ALL match. */
export function termsOf(query) {
  return (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}
