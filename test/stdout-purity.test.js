// On stdio transport the JSON-RPC stream IS stdout, so one stray console.log
// anywhere under src/ corrupts every message after it. The client then reports a
// parse error naming no file, and the server looks fine from the inside. Nothing
// in the code prevents that, so this test does.
//
// Diagnostics belong on stderr, which is what every existing message in src/
// already uses. The one exception is the --version / --help block in index.js:
// it runs before any transport exists and calls process.exit(0), so stdout is
// still a plain terminal at that point. That exemption is bounded below rather
// than assumed, and the second half of this file proves the two flags really do
// exit without ever connecting.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { TOOLS } from '../src/registry.js';

const execFileAsync = promisify(execFile);

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const CLI_TIMEOUT_MS = 20000;
// The banner index.js writes once it is serving. On stderr, where it belongs.
const BANNER = /running on stdio/;

// Everything on this list writes to stdout, which on this transport means into
// the middle of a JSON-RPC message.
const STDOUT_WRITERS = [
  /\bconsole\.log\s*\(/,
  /\bconsole\.info\s*\(/,
  /\bconsole\.debug\s*\(/,
  /\bconsole\.dir\s*\(/,
  /\bconsole\.table\s*\(/,
  /\bprocess\.stdout\.write\s*\(/
];

/** Every .js file under src/, however deep. */
function sourceFiles(dir = SRC_DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

const indexLines = readFileSync(SERVER, 'utf8').split('\n');
// The CLI block is everything above the server object. Past that line a print
// can race a real message, so nothing above it is exempt by accident and
// nothing below it is exempt at all.
const cliBlockEnds = indexLines.findIndex((line) => line.includes('new Server('));

describe('stdout belongs to the protocol', () => {
  it('finds the source files it is supposed to be scanning', () => {
    const files = sourceFiles();
    assert.ok(files.length >= 10, `only found ${files.length} source files under src/, so this scan proves nothing`);
    assert.ok(files.includes(SERVER), 'src/index.js was not scanned');
  });

  it('bounds the CLI exemption to the block that runs before the transport exists', () => {
    // If this line ever moves or is renamed, the exemption below would silently
    // cover the whole file.
    assert.ok(cliBlockEnds > 0, 'could not find where index.js constructs the server, so the exemption is unbounded');
    const cliBlock = indexLines.slice(0, cliBlockEnds).join('\n');
    assert.match(cliBlock, /process\.exit\(0\)/, 'the exempt block no longer exits, so it can reach the transport');
  });

  it('no file under src/ writes to stdout outside that block', () => {
    for (const file of sourceFiles()) {
      const where = `src/${relative(SRC_DIR, file)}`;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const pattern = STDOUT_WRITERS.find((candidate) => candidate.test(line));
        if (!pattern) return;
        const exempt = file === SERVER && index < cliBlockEnds;
        assert.ok(
          exempt,
          `${where}:${index + 1} writes to stdout, which is the JSON-RPC stream: ${line.trim()}`
        );
      });
    }
  });
});

describe('the CLI flags print and exit without connecting', () => {
  it('--version prints the version alone, so a script can read it', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SERVER, '--version'], { timeout: CLI_TIMEOUT_MS });
    assert.equal(stdout.trim(), PACKAGE.version);
    assert.doesNotMatch(stderr, BANNER, '--version connected a transport before exiting');
  });

  it('--help prints usage and never starts serving', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SERVER, '--help'], { timeout: CLI_TIMEOUT_MS });
    assert.match(stdout, /arc-control-mcp/);
    assert.match(
      stdout,
      new RegExp(`Exposes ${TOOLS.length} tools`),
      `the help text no longer reports the ${TOOLS.length} tools the registry exposes`
    );
    assert.doesNotMatch(stderr, BANNER, '--help connected a transport before exiting');
  });
});
