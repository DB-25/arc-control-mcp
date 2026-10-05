import { execFile } from 'child_process';
import { copyFile, mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { LocalDataError, dataDir } from './arc-data.js';

/**
 * Arc's browsing history is a Chromium SQLite database. It is locked while Arc
 * runs, so this works on a private copy that is deleted before returning, and
 * shells out to the sqlite3 that ships with macOS rather than adding a native
 * dependency.
 */
const SQLITE3 = '/usr/bin/sqlite3';
const SQLITE_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_CHARS = 200;

/** Chromium stores visit times as microseconds since 1601-01-01. */
const WEBKIT_EPOCH_OFFSET_MS = 11644473600000;
const MS_PER_DAY = 86400000;

/** The columns this reads, checked up front so a schema change fails clearly. */
const REQUIRED_COLUMNS = {
  urls: ['id', 'url', 'title', 'visit_count', 'hidden'],
  visits: ['id', 'url', 'visit_time']
};

export const HISTORY_OPT_IN_ERROR =
  'search_history is disabled because browsing history is sensitive. To enable it, set ARC_MCP_ALLOW_HISTORY=1 in this MCP server\'s environment ' +
  '(for example: claude mcp add arc --scope user -e ARC_MCP_ALLOW_HISTORY=1 -- npx -y arc-control-mcp@latest) and restart the client.';

export const historyAllowed = () => process.env.ARC_MCP_ALLOW_HISTORY === '1';

/** Run SQL on stdin. Nothing from the caller ever reaches argv, where `ps` could show it. */
function runSqlite(databasePath, sql) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      SQLITE3,
      ['-readonly', '-json', databasePath],
      { timeout: SQLITE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error?.code === 'ENOENT') {
          return reject(new LocalDataError(`${SQLITE3} was not found. search_history needs the sqlite3 command that ships with macOS.`));
        }
        if (error) {
          const detail = (stderr || error.message).toString().trim().slice(0, MAX_ERROR_CHARS);
          return reject(new LocalDataError(`Reading the history database failed: ${detail}`));
        }
        // sqlite3 prints nothing at all, not "[]", when a query returns no rows.
        resolve(stdout.trim() ? JSON.parse(stdout) : []);
      }
    );
    child.stdin.on('error', () => {});
    child.stdin.end(sql);
  });
}

/**
 * The search text goes in as a hex blob, so no quote, newline or dot-command in
 * it can change the statement. LIKE wildcards are escaped so they match literally.
 */
function containsClause(term) {
  const escaped = term.replace(/[\\%_]/g, '\\$&');
  const hex = Buffer.from(escaped, 'utf8').toString('hex');
  const pattern = `'%'||CAST(x'${hex}' AS TEXT)||'%'`;
  return `(u.url LIKE ${pattern} ESCAPE '\\' OR u.title LIKE ${pattern} ESCAPE '\\')`;
}

function checkSchema(columnRows) {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const have = new Set(columnRows.filter((row) => row.t === table).map((row) => row.name));
    const missing = required.filter((column) => !have.has(column));
    if (missing.length) {
      throw new LocalDataError(
        `The history database's ${table} table lacks ${missing.join(', ')}, so its schema is not the Chromium one this server understands.`
      );
    }
  }
}

/**
 * Pages visited whose title or URL contains every term, newest first. The
 * window is [now - sinceDays, now - untilDays]. Returns one row per page.
 */
export async function queryHistory({ profile, terms, sinceDays, untilDays, limit, now = Date.now() }) {
  const source = join(dataDir(), 'User Data', profile, 'History');
  let info;
  try {
    info = await stat(source);
  } catch {
    throw new LocalDataError(
      `No history database at ${join('User Data', profile, 'History')} under ${dataDir()}. ` +
        'The profile name is the folder under "User Data" ("Default" unless the space uses another profile).'
    );
  }

  const fromMs = now - sinceDays * MS_PER_DAY;
  const toMs = now - untilDays * MS_PER_DAY;
  const webkit = (ms) => Math.floor(ms + WEBKIT_EPOCH_OFFSET_MS) * 1000;
  const filters = [
    `v.visit_time >= ${webkit(fromMs)}`,
    `v.visit_time <= ${webkit(toMs)}`,
    'u.hidden = 0',
    ...terms.map(containsClause)
  ];
  const sql = `
    SELECT u.url AS url, u.title AS title, u.visit_count AS visitCount,
           COUNT(v.id) AS visitsInWindow,
           MAX(v.visit_time) / 1000 - ${WEBKIT_EPOCH_OFFSET_MS} AS lastVisitMs
    FROM urls u JOIN visits v ON v.url = u.id
    WHERE ${filters.join(' AND ')}
    GROUP BY u.id ORDER BY lastVisitMs DESC LIMIT ${limit + 1};`;

  const workDir = await mkdtemp(join(tmpdir(), 'arc-mcp-history-'));
  try {
    const copy = join(workDir, 'History');
    await copyFile(source, copy);
    const columns = await runSqlite(
      copy,
      `SELECT 'urls' AS t, name FROM pragma_table_info('urls') UNION ALL SELECT 'visits', name FROM pragma_table_info('visits');`
    );
    checkSchema(columns);
    const rows = await runSqlite(copy, sql);
    return {
      asOf: info.mtime.toISOString(),
      truncated: rows.length > limit,
      rows: rows.slice(0, limit).map((row) => ({
        url: row.url,
        title: row.title || null,
        visitCount: row.visitCount,
        visitsInWindow: row.visitsInWindow,
        lastVisitedAt: new Date(row.lastVisitMs).toISOString()
      }))
    };
  } finally {
    // The copy is a second, unprotected instance of private data.
    await rm(workDir, { recursive: true, force: true });
  }
}
