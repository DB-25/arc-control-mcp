// The local data tools read Arc's own files, which hold the user's private
// browsing data. Every test here runs against synthetic fixtures written into a
// temp directory and pointed at with ARC_MCP_ARC_DATA_DIR, so nothing real is
// ever read, printed or asserted on.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANDLERS } from '../src/registry.js';

const SQLITE3 = '/usr/bin/sqlite3';
const DAY_MS = 86400000;
const COCOA_OFFSET_S = 978307200;
const WEBKIT_OFFSET_MS = 11644473600000n;

const NOW = Date.now();
const cocoa = (daysAgo) => NOW / 1000 - COCOA_OFFSET_S - daysAgo * 86400;

const tab = (id, parentID, title, url, daysAgo, extra = {}) => ({
  id,
  parentID,
  title: extra.renamed ?? null,
  childrenIds: [],
  data: { tab: { savedTitle: title, savedURL: url, ...(daysAgo === null ? {} : { timeLastActiveAt: cocoa(daysAgo) }) } }
});
const folder = (id, parentID, title, childrenIds) => ({ id, parentID, title, childrenIds, data: { list: {} } });
const container = (id, childrenIds, containerType) => ({ id, parentID: null, title: null, childrenIds, data: { itemContainer: { containerType } } });

// Arc interleaves ids and objects: [id, {..}, id, {..}].
const interleave = (objects) => objects.flatMap((o) => [o.id, o]);

const SHARED_URL = 'https://example.com/shared';

function sidebarFixture(version = 1) {
  const spaces = [
    {
      id: 'space-work',
      title: 'Work',
      containerIDs: ['pinned', 'pin-work', 'unpinned', 'unp-work'],
      newContainerIDs: [{ pinned: {} }, 'pin-work', { unpinned: { _0: { shared: {} } } }, 'unp-work'],
      profile: { default: true }
    },
    {
      id: 'space-home',
      title: 'Home',
      containerIDs: ['pinned', 'pin-home', 'unpinned', 'unp-home'],
      newContainerIDs: [{ pinned: {} }, 'pin-home', { unpinned: {} }, 'unp-home'],
      profile: { default: true }
    }
  ];
  const items = [
    container('pin-work', ['fold-research', 'tab-pinned', 'gone-id'], { spaceItems: { _0: 'space-work' } }),
    folder('fold-research', 'pin-work', 'Research', ['tab-f1', 'fold-deep']),
    folder('fold-deep', 'fold-research', 'Deep', ['tab-f2']),
    tab('tab-pinned', 'pin-work', 'Pinned Original', 'https://example.com/pinned', 2, { renamed: 'My Pinned Name' }),
    tab('tab-f1', 'fold-research', 'Research One', 'https://example.com/r1', 30),
    tab('tab-f2', 'fold-deep', 'Research Deep', SHARED_URL, 400),
    container('unp-work', ['tab-u1', 'tab-u2'], { spaceItems: { _0: 'space-work' } }),
    tab('tab-u1', 'unp-work', 'Unpinned Old', SHARED_URL, 20),
    tab('tab-u2', 'unp-work', 'Unpinned Fresh', 'https://example.com/fresh', 0.1),
    container('pin-home', [], { spaceItems: { _0: 'space-home' } }),
    container('unp-home', ['tab-b1', 'tab-b2'], { spaceItems: { _0: 'space-home' } }),
    tab('tab-b1', 'unp-home', 'Home Shared', SHARED_URL, 9),
    tab('tab-b2', 'unp-home', 'Home No Time', 'https://example.com/untimed', null),
    container('top', ['tab-top'], { topApps: { _0: { default: true } } }),
    tab('tab-top', 'top', 'Top App Mail', 'https://mail.example.com/', 60)
  ];
  return {
    version,
    sidebar: {
      containers: [
        { global: {} },
        { spaces: ['space-work', spaces[0], 'space-home', spaces[1]], items: interleave(items), topAppsContainerIDs: [{ default: true }, 'top'] }
      ]
    }
  };
}

const archived = (id, title, url, archivedDaysAgo, reason, source = { space: { _0: 'space-work' } }) => ({
  reason,
  archivedAt: cocoa(archivedDaysAgo),
  source,
  sidebarItem: { id, parentID: null, title: null, childrenIds: [], data: { tab: { savedTitle: title, savedURL: url, timeLastActiveAt: cocoa(archivedDaysAgo + 1) } } }
});

function archiveFixture(version = 1) {
  const entries = [
    archived('a1', 'Alpha Report', 'https://example.com/alpha', 1, 'manual'),
    archived('a2', 'Alpha Notes', 'https://notes.example.com/alpha', 10, 'auto', { space: { _0: 'space-home' } }),
    archived('a3', 'Beta Draft', 'https://example.com/beta', 5, 'auto', { littleArc: {} }),
    archived('a4', 'Gamma', 'https://example.com/gamma', 100, 'manual', { space: { _0: 'space-unknown' } })
  ];
  // An archived folder with nothing to search must be dropped, not listed blank.
  entries.push({ reason: 'manual', archivedAt: cocoa(2), source: { unknown: {} }, sidebarItem: { id: 'a5', title: null, childrenIds: [], data: { tab: {} } } });
  return { version, items: interleave(entries) };
}

const webkit = (daysAgo) => ((BigInt(NOW - Math.round(daysAgo * DAY_MS)) + WEBKIT_OFFSET_MS) * 1000n).toString();

function writeHistory(path, { withVisits = true } = {}) {
  const pages = [
    [1, 'https://example.com/docs/intro', 'Intro Docs', 3, 0],
    [2, 'https://example.com/docs/api', 'API Reference', 2, 40],
    [3, 'https://news.example.com/story', 'Big 100% Story', 1, 6],
    [4, 'https://hidden.example.com/', 'Hidden Page', 1, 1]
  ];
  const sql = [
    'CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER DEFAULT 0 NOT NULL,typed_count INTEGER DEFAULT 0 NOT NULL,last_visit_time INTEGER NOT NULL,hidden INTEGER DEFAULT 0 NOT NULL);',
    withVisits
      ? 'CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT,url INTEGER NOT NULL,visit_time INTEGER NOT NULL);'
      : 'CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT,url INTEGER NOT NULL);',
    ...pages.map(([id, url, title, count, ago]) => {
      const hidden = id === 4 ? 1 : 0;
      return `INSERT INTO urls VALUES(${id},'${url}','${title}',${count},0,${webkit(ago)},${hidden});`;
    })
  ];
  if (withVisits) {
    // Page 1 has two visits, one inside and one outside a 7 day window.
    for (const [id, ago] of [[1, 0], [1, 40], [2, 40], [3, 6], [4, 1]]) {
      sql.push(`INSERT INTO visits(url, visit_time) VALUES(${id}, ${webkit(ago)});`);
    }
  }
  execFileSync(SQLITE3, [path], { input: sql.join('\n') });
}

let root;
let dir;
let savedEnv;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'arc-local-test-'));
  savedEnv = { dir: process.env.ARC_MCP_ARC_DATA_DIR, allow: process.env.ARC_MCP_ALLOW_HISTORY, tmp: process.env.TMPDIR };
});

after(() => {
  for (const [key, value] of [['ARC_MCP_ARC_DATA_DIR', savedEnv.dir], ['ARC_MCP_ALLOW_HISTORY', savedEnv.allow], ['TMPDIR', savedEnv.tmp]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(root, 'data-'));
  process.env.ARC_MCP_ARC_DATA_DIR = dir;
  delete process.env.ARC_MCP_ALLOW_HISTORY;
});

const put = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
const seed = () => {
  put('StorableSidebar.json', sidebarFixture());
  put('StorableArchiveItems.json', archiveFixture());
};
const titlesIn = (nodes) => nodes.map((n) => n.title);

describe('sidebar_tree', () => {
  it('nests folders, separates pinned from unpinned, and lists top apps apart', async () => {
    seed();
    const out = await HANDLERS.sidebar_tree({});
    assert.equal(out.ok, true);
    const work = out.spaces.find((s) => s.title === 'Work');
    // A user rename on a pinned tab wins over the page's own title.
    assert.deepEqual(titlesIn(work.pinned), ['Research', 'My Pinned Name']);
    const research = work.pinned[0];
    assert.equal(research.kind, 'folder');
    assert.deepEqual(titlesIn(research.children), ['Research One', 'Deep']);
    assert.deepEqual(titlesIn(research.children[1].children), ['Research Deep']);
    assert.deepEqual(titlesIn(work.unpinned), ['Unpinned Old', 'Unpinned Fresh']);
    assert.deepEqual(titlesIn(out.topApps), ['Top App Mail']);
    assert.deepEqual(out.spaces.find((s) => s.title === 'Home').pinned, []);
  });

  it('reports counts, and ignores a child id that points at nothing', async () => {
    seed();
    const out = await HANDLERS.sidebar_tree({});
    assert.equal(out.totalTabs, 8);
    assert.equal(out.returnedTabs, 8);
    assert.equal(out.folderCount, 2);
    assert.equal(out.truncated, false);
  });

  it('gives each tab the id, url and an ISO last-active time', async () => {
    seed();
    const out = await HANDLERS.sidebar_tree({ space: 'Work' });
    const fresh = out.spaces[0].unpinned[1];
    assert.equal(fresh.id, 'tab-u2');
    assert.equal(fresh.url, 'https://example.com/fresh');
    assert.ok(Math.abs(Date.parse(fresh.lastActiveAt) - (NOW - 0.1 * DAY_MS)) < 1000);
  });

  it('filters by space title (any case) or id, and drops top apps when filtering', async () => {
    seed();
    const byTitle = await HANDLERS.sidebar_tree({ space: 'hOmE' });
    assert.deepEqual(byTitle.spaces.map((s) => s.id), ['space-home']);
    assert.deepEqual(byTitle.topApps, []);
    assert.equal(byTitle.totalTabs, 2);
    const byId = await HANDLERS.sidebar_tree({ space: 'space-work' });
    assert.deepEqual(byId.spaces.map((s) => s.title), ['Work']);
  });

  it('fails clearly for an unknown space, naming the real ones', async () => {
    seed();
    const out = await HANDLERS.sidebar_tree({ space: 'Nope' });
    assert.equal(out.ok, false);
    assert.match(out.error, /Work/);
  });

  it('omits urls when include_urls is false', async () => {
    seed();
    const out = await HANDLERS.sidebar_tree({ include_urls: false });
    assert.ok(!JSON.stringify(out).includes('example.com'));
  });

  it('stops at max_items and says so', async () => {
    seed();
    const out = await HANDLERS.sidebar_tree({ max_items: 3 });
    assert.equal(out.returnedTabs, 3);
    assert.equal(out.totalTabs, 8);
    assert.equal(out.truncated, true);
  });

  it('reports the file modification time as asOf, with the freshness caveat', async () => {
    seed();
    const stamp = new Date('2026-01-02T03:04:05.000Z');
    utimesSync(join(dir, 'StorableSidebar.json'), stamp, stamp);
    const out = await HANDLERS.sidebar_tree({});
    assert.equal(out.asOf, stamp.toISOString());
    assert.match(out.note, /periodically/);
  });

  it('does not mark tabs live unless asked, since that costs an Apple Events call', async () => {
    seed();
    const out = await HANDLERS.sidebar_tree({});
    assert.ok(!JSON.stringify(out).includes('"live"'));
  });
});

describe('find_stale_tabs', () => {
  it('lists tabs idle at least N days, oldest first, with space and location', async () => {
    seed();
    const out = await HANDLERS.find_stale_tabs({ days: 7 });
    assert.equal(out.ok, true);
    assert.deepEqual(out.stale.map((t) => t.id), ['tab-f2', 'tab-top', 'tab-f1', 'tab-u1', 'tab-b1']);
    const deep = out.stale[0];
    assert.equal(deep.space, 'Work');
    assert.equal(deep.location, 'pinned');
    assert.equal(deep.folder, 'Research / Deep');
    assert.equal(deep.idleDays, 400);
    const top = out.stale[1];
    assert.equal(top.location, 'topApp');
    assert.equal(top.space, null);
    assert.equal(out.stale[3].location, 'unpinned');
  });

  it('honours the threshold and the space filter', async () => {
    seed();
    const out = await HANDLERS.find_stale_tabs({ days: 100 });
    assert.deepEqual(out.stale.map((t) => t.id), ['tab-f2']);
    const home = await HANDLERS.find_stale_tabs({ days: 1, space: 'Home' });
    assert.deepEqual(home.stale.map((t) => t.id), ['tab-b1']);
  });

  it('counts tabs with no activity time instead of guessing them stale', async () => {
    seed();
    const out = await HANDLERS.find_stale_tabs({ days: 0 });
    assert.equal(out.unknownActivity, 1);
    assert.ok(!out.stale.some((t) => t.id === 'tab-b2'));
  });

  it('flags exact duplicate URLs across spaces and folders', async () => {
    seed();
    const out = await HANDLERS.find_stale_tabs({ days: 7 });
    assert.equal(out.duplicateUrlCount, 1);
    assert.equal(out.duplicates[0].url, SHARED_URL);
    assert.equal(out.duplicates[0].count, 3);
    assert.deepEqual(out.duplicates[0].tabs.map((t) => t.id).sort(), ['tab-b1', 'tab-f2', 'tab-u1']);
    assert.equal(out.stale.find((t) => t.id === 'tab-f2').isDuplicate, true);
    assert.equal(out.stale.find((t) => t.id === 'tab-f1').isDuplicate, false);
  });

  it('skips duplicate work when include_duplicates is false', async () => {
    seed();
    const out = await HANDLERS.find_stale_tabs({ include_duplicates: false });
    assert.ok(!('duplicates' in out));
    assert.ok(!('isDuplicate' in out.stale[0]));
  });

  it('caps the result and says it was cut', async () => {
    seed();
    const out = await HANDLERS.find_stale_tabs({ days: 7, limit: 2 });
    assert.equal(out.stale.length, 2);
    assert.equal(out.staleCount, 5);
    assert.equal(out.truncated, true);
  });
});

describe('search_archive', () => {
  it('returns newest first and requires every word to match', async () => {
    seed();
    const all = await HANDLERS.search_archive({});
    assert.deepEqual(all.results.map((r) => r.title), ['Alpha Report', 'Beta Draft', 'Alpha Notes', 'Gamma']);
    assert.equal(all.archiveSize, 4);
    const alpha = await HANDLERS.search_archive({ query: 'alpha' });
    assert.deepEqual(alpha.results.map((r) => r.title), ['Alpha Report', 'Alpha Notes']);
    const narrowed = await HANDLERS.search_archive({ query: 'ALPHA notes.example' });
    assert.deepEqual(narrowed.results.map((r) => r.title), ['Alpha Notes']);
  });

  it('filters by reason and window', async () => {
    seed();
    const auto = await HANDLERS.search_archive({ reason: 'auto' });
    assert.deepEqual(auto.results.map((r) => r.title), ['Beta Draft', 'Alpha Notes']);
    const recent = await HANDLERS.search_archive({ since_days: 7 });
    assert.deepEqual(recent.results.map((r) => r.title), ['Alpha Report', 'Beta Draft']);
  });

  it('names the space an item came from, falling back to the raw id and the source kind', async () => {
    seed();
    const out = await HANDLERS.search_archive({});
    const by = (title) => out.results.find((r) => r.title === title);
    assert.equal(by('Alpha Report').space, 'Work');
    assert.equal(by('Alpha Notes').space, 'Home');
    assert.equal(by('Beta Draft').from, 'littleArc');
    assert.equal(by('Beta Draft').space, undefined);
    assert.equal(by('Gamma').space, 'space-unknown');
  });

  it('still searches when the sidebar file is gone', async () => {
    put('StorableArchiveItems.json', archiveFixture());
    const out = await HANDLERS.search_archive({ query: 'beta' });
    assert.equal(out.ok, true);
    assert.equal(out.results.length, 1);
  });

  it('caps results and reports the full match count', async () => {
    seed();
    const out = await HANDLERS.search_archive({ limit: 1 });
    assert.equal(out.results.length, 1);
    assert.equal(out.matchCount, 4);
    assert.equal(out.truncated, true);
  });
});

describe('failing clearly', () => {
  it('reports a missing data file with the variable that relocates it', async () => {
    for (const name of ['sidebar_tree', 'find_stale_tabs', 'search_archive']) {
      const out = await HANDLERS[name]({});
      assert.equal(out.ok, false, name);
      assert.match(out.error, /was not found/, name);
      assert.match(out.error, /ARC_MCP_ARC_DATA_DIR/, name);
    }
  });

  it('refuses a file format version it was not written for', async () => {
    put('StorableSidebar.json', sidebarFixture(2));
    put('StorableArchiveItems.json', archiveFixture(7));
    for (const name of ['sidebar_tree', 'find_stale_tabs', 'search_archive']) {
      const out = await HANDLERS[name]({});
      assert.equal(out.ok, false, name);
      assert.match(out.error, /version/, name);
    }
  });

  it('refuses a file with the right version but an unknown layout', async () => {
    put('StorableSidebar.json', { version: 1, sidebar: { containers: [{ global: {} }] } });
    const out = await HANDLERS.sidebar_tree({});
    assert.equal(out.ok, false);
    assert.match(out.error, /layout/);
  });

  it('says a half-written file is not valid JSON rather than crashing', async () => {
    writeFileSync(join(dir, 'StorableSidebar.json'), '{"version": 1, "sidebar": ');
    const out = await HANDLERS.sidebar_tree({});
    assert.equal(out.ok, false);
    assert.match(out.error, /not valid JSON/);
  });

  it('never modifies the files it reads', async () => {
    seed();
    const digest = () => createHash('sha256').update(readFileSync(join(dir, 'StorableSidebar.json'))).update(readFileSync(join(dir, 'StorableArchiveItems.json'))).digest('hex');
    const before = digest();
    await HANDLERS.sidebar_tree({});
    await HANDLERS.find_stale_tabs({});
    await HANDLERS.search_archive({});
    assert.equal(digest(), before);
    assert.deepEqual(readdirSync(dir).sort(), ['StorableArchiveItems.json', 'StorableSidebar.json']);
  });
});

describe('search_history', { skip: !existsSync(SQLITE3) && 'needs the sqlite3 that ships with macOS' }, () => {
  const dbPath = () => join(dir, 'User Data', 'Default', 'History');
  const enable = () => {
    process.env.ARC_MCP_ALLOW_HISTORY = '1';
  };
  const seedHistory = (options) => {
    mkdirSync(join(dir, 'User Data', 'Default'), { recursive: true });
    writeHistory(dbPath(), options);
  };

  it('is off unless ARC_MCP_ALLOW_HISTORY=1, and says how to turn it on', async () => {
    seedHistory();
    const out = await HANDLERS.search_history({ query: 'docs' });
    assert.equal(out.ok, false);
    assert.match(out.error, /ARC_MCP_ALLOW_HISTORY=1/);
    // Anything but the exact opt-in value stays off.
    process.env.ARC_MCP_ALLOW_HISTORY = 'true';
    assert.equal((await HANDLERS.search_history({})).ok, false);
  });

  it('checks the opt-in before it touches any file', async () => {
    const out = await HANDLERS.search_history({});
    assert.equal(out.ok, false);
    assert.match(out.error, /ARC_MCP_ALLOW_HISTORY=1/);
  });

  it('searches title and url, newest first, one row per page', async () => {
    seedHistory();
    enable();
    const out = await HANDLERS.search_history({ since_days: 365 });
    assert.equal(out.ok, true);
    // Page 4 is hidden, so it never appears.
    assert.deepEqual(out.results.map((r) => r.title), ['Intro Docs', 'Big 100% Story', 'API Reference']);
    const docs = await HANDLERS.search_history({ query: 'DOCS', since_days: 365 });
    assert.deepEqual(docs.results.map((r) => r.url), ['https://example.com/docs/intro', 'https://example.com/docs/api']);
    const both = await HANDLERS.search_history({ query: 'docs reference', since_days: 365 });
    assert.deepEqual(both.results.map((r) => r.title), ['API Reference']);
  });

  it('applies the time window and counts visits inside it', async () => {
    seedHistory();
    enable();
    const week = await HANDLERS.search_history({ since_days: 7 });
    assert.deepEqual(week.results.map((r) => r.title), ['Intro Docs', 'Big 100% Story']);
    assert.equal(week.results[0].visitsInWindow, 1);
    const wide = await HANDLERS.search_history({ since_days: 365 });
    assert.equal(wide.results.find((r) => r.title === 'Intro Docs').visitsInWindow, 2);
    const past = await HANDLERS.search_history({ since_days: 365, until_days: 30 });
    assert.deepEqual(past.results.map((r) => r.title).sort(), ['API Reference', 'Intro Docs']);
    assert.ok(Math.abs(Date.parse(week.results[0].lastVisitedAt) - NOW) < 1000);
  });

  it('rejects a window that ends before it starts', async () => {
    seedHistory();
    enable();
    const out = await HANDLERS.search_history({ since_days: 1, until_days: 5 });
    assert.equal(out.ok, false);
    assert.match(out.error, /window is empty/);
  });

  it('caps results and flags truncation', async () => {
    seedHistory();
    enable();
    const out = await HANDLERS.search_history({ since_days: 365, limit: 2 });
    assert.equal(out.results.length, 2);
    assert.equal(out.truncated, true);
  });

  it('treats the query as text: quotes, SQL and LIKE wildcards match literally', async () => {
    seedHistory();
    enable();
    const hostile = await HANDLERS.search_history({ query: "x'; DROP TABLE urls; --", since_days: 365 });
    assert.equal(hostile.ok, true);
    assert.equal(hostile.results.length, 0);
    // The table survived.
    assert.equal((await HANDLERS.search_history({ since_days: 365 })).results.length, 3);
    // A bare % would match everything if it were a wildcard.
    const percent = await HANDLERS.search_history({ query: '100%', since_days: 365 });
    assert.deepEqual(percent.results.map((r) => r.title), ['Big 100% Story']);
    assert.equal((await HANDLERS.search_history({ query: '%', since_days: 365 })).results.length, 1);
    assert.equal((await HANDLERS.search_history({ query: '_', since_days: 365 })).results.length, 0);
  });

  /** Point os.tmpdir() at an empty directory for one run, so leftovers are visible. */
  async function withScratchTmp(run) {
    const scratch = mkdtempSync(join(root, 'tmp-'));
    process.env.TMPDIR = scratch;
    try {
      await run();
      assert.deepEqual(readdirSync(scratch), []);
    } finally {
      if (savedEnv.tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedEnv.tmp;
    }
  }

  it('removes its private copy of the database, and leaves the original alone', async () => {
    seedHistory();
    enable();
    const digest = () => createHash('sha256').update(readFileSync(dbPath())).digest('hex');
    const before = digest();
    await withScratchTmp(async () => {
      assert.equal((await HANDLERS.search_history({ since_days: 365 })).ok, true);
    });
    assert.equal(digest(), before);
  });

  it('fails clearly when the profile has no history database', async () => {
    enable();
    const out = await HANDLERS.search_history({ profile: 'Profile 1' });
    assert.equal(out.ok, false);
    assert.match(out.error, /No history database/);
  });

  it('fails clearly, and cleans up, when the schema is not the Chromium one', async () => {
    seedHistory({ withVisits: false });
    enable();
    await withScratchTmp(async () => {
      const out = await HANDLERS.search_history({});
      assert.equal(out.ok, false);
      assert.match(out.error, /visit_time/);
    });
  });

  it('refuses a profile name that could escape the data directory', async () => {
    enable();
    for (const profile of ['..', '../..', 'a/b']) {
      await assert.rejects(() => HANDLERS.search_history({ profile }), /Invalid arguments for search_history/, profile);
    }
  });
});
