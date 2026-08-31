// The MCP wire contract, spoken to a real child process. This is the only test
// that talks JSON-RPC to `node src/index.js` over stdio.
//
// It exists for the isError rule. index.js decides in one place whether a
// handler reported failure (ok: false, or a bare error string) and sets isError
// on the tool result, because the spec wants a tool that RAN and failed
// reported in-result so the model can see it and correct itself, while a tool
// that could not be FOUND is a protocol error. Those two go down different
// paths and only the wire shows which one a caller actually gets.
//
// No Arc is involved. Every call below is either answered from memory or fails
// before it can reach osascript, so this runs on Linux in CI exactly as it does
// on a Mac. The state directory is redirected to a temp directory so a run
// cannot touch a real agent's ownership file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Long enough that a cold module graph on a loaded CI box is not a failure,
// short enough that a wedged server fails the test instead of hanging the run.
const REPLY_TIMEOUT_MS = 20000;
const EXPECTED_TOOLS = 26;
// JSON-RPC "Invalid params", which is what ErrorCode.InvalidParams maps to.
const INVALID_PARAMS = -32602;
// Any version in the SDK's supported list; the server echoes what it is given.
const PROTOCOL_VERSION = '2025-06-18';

/**
 * A running server plus the little bit of client needed to talk to it: one
 * request at a time, correlated by id, with the reply parsed off stdout.
 * The startup banner goes to stderr, so every line on stdout has to be a
 * message and a stray print anywhere under src/ would break this parse. That is
 * deliberate: see stdout-purity.test.js.
 */
function start() {
  const stateDir = mkdtempSync(join(tmpdir(), 'arc-protocol-'));
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ARC_MCP_STATE_DIR: join(stateDir, 'state'),
      ARC_MCP_LABEL: 'arc-control-protocol-test'
    }
  });

  const pending = new Map();
  const stderr = [];
  let buffered = '';
  let nextId = 1;
  let died = null;

  const fail = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let cut;
    while ((cut = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // A stray print under src/ lands here, mid-stream, and every later
        // message with it. stdout-purity.test.js is the tripwire for that.
        fail(new Error(`stdout carried something that is not a JSON-RPC message: ${line.slice(0, 200)}`));
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  // A dead server must fail the test rather than leave it waiting on a reply.
  child.on('exit', (code, signal) => {
    died = { code, signal };
    fail(new Error(`the server exited (code ${code}, signal ${signal}) with stderr: ${stderr.join('')}`));
  });
  // The child is killed while the test still holds the pipe, so EPIPE here is
  // expected rather than interesting.
  child.stdin.on('error', () => {});

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  const request = (method, params) => {
    const id = nextId++;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no reply to ${method} within ${REPLY_TIMEOUT_MS}ms; stderr: ${stderr.join('')}`));
      }, REPLY_TIMEOUT_MS);
      pending.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    send({ jsonrpc: '2.0', id, method, params });
    return reply;
  };

  return {
    request,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    stderrText: () => stderr.join(''),
    async stop() {
      if (!died) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      rmSync(stateDir, { recursive: true, force: true });
    }
  };
}

/**
 * Handshake, run the body, and kill the server however the body ends. The kill
 * is in a finally so a failing assertion can never leak a child process.
 */
async function withServer(body) {
  const server = start();
  try {
    const initialized = await server.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'arc-control-protocol-test', version: '0.0.0' }
    });
    server.notify('notifications/initialized');
    return await body(server, initialized);
  } finally {
    await server.stop();
  }
}

/** Tool results carry the handler's JSON as text, which is what a model reads. */
const payloadOf = (result) => {
  assert.equal(result.content[0].type, 'text', 'a tool result must carry a text block');
  return JSON.parse(result.content[0].text);
};

describe('the initialize handshake', () => {
  it('reports a protocol version, tool capability and instructions', async () => {
    await withServer(async (server, initialized) => {
      const { result, error } = initialized;
      assert.equal(error, undefined, `initialize failed: ${JSON.stringify(error)}`);
      assert.match(result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/, 'protocolVersion is not a spec version');
      assert.equal(typeof result.capabilities?.tools, 'object', 'a tools capability is what makes tools/list legal');
      assert.notEqual(result.capabilities.tools, null);

      // The model never reads the README, so instructions are the only place it
      // learns that a bare call can land on the tab the user is looking at.
      assert.equal(typeof result.instructions, 'string');
      assert.ok(result.instructions.trim().length > 0, 'instructions are empty');
      assert.match(result.instructions, /arc_status/, 'instructions no longer point at arc_status');
      assert.match(result.instructions, /tab_id/, 'instructions no longer explain tab_id');
    });
  });

  it('identifies itself with a name, version, title and website a client can display', async () => {
    await withServer(async (server, initialized) => {
      const { serverInfo } = initialized.result;
      assert.equal(serverInfo.name, 'arc-control');
      // Hardcoding the version in index.js once let the server report 0.2.0
      // while package.json still said 0.1.0.
      assert.equal(serverInfo.version, PACKAGE.version, 'serverInfo.version has drifted from package.json');
      assert.equal(typeof serverInfo.title, 'string');
      assert.ok(serverInfo.title.trim().length > 0, 'serverInfo.title is empty, so clients fall back to the bare name');
      assert.match(serverInfo.websiteUrl, /^https:\/\//, 'serverInfo.websiteUrl is not a usable link');
    });
  });
});

describe('tools/list over the wire', () => {
  it(`returns all ${EXPECTED_TOOLS} tools in one page, with no nextCursor to chase`, async () => {
    await withServer(async (server) => {
      const { result, error } = await server.request('tools/list', {});
      assert.equal(error, undefined, `tools/list failed: ${JSON.stringify(error)}`);
      assert.equal(result.tools.length, EXPECTED_TOOLS);
      assert.equal('nextCursor' in result, false, 'a nextCursor makes a client ask for a second page that does not exist');
    });
  });

  it('sends every tool with the fields a client needs to render and gate it', async () => {
    await withServer(async (server) => {
      const { result } = await server.request('tools/list', {});
      for (const tool of result.tools) {
        assert.equal(typeof tool.name, 'string', 'a tool arrived with no name');
        assert.ok(tool.description?.trim().length > 0, `${tool.name} arrived with no description`);
        assert.equal(tool.inputSchema?.type, 'object', `${tool.name} arrived with no object inputSchema`);
        assert.ok(tool.title?.trim().length > 0, `${tool.name} arrived with no title`);
        assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} arrived with no hints`);
      }
    });
  });
});

describe('tools/call maps failure the way the spec asks', () => {
  it('answers an unknown tool with a JSON-RPC error, not with a tool result', async () => {
    // Failing to FIND a tool is a protocol error. Reporting it as a result with
    // isError would tell the model the call ran, and it would retry the name.
    await withServer(async (server) => {
      const reply = await server.request('tools/call', { name: 'no_such_tool', arguments: {} });
      assert.equal(reply.result, undefined, 'an unknown tool must not come back as a result');
      assert.equal(reply.error.code, INVALID_PARAMS, `unknown tool answered with code ${reply.error?.code}`);
      assert.match(reply.error.message, /no_such_tool/, 'the error does not name the tool that was asked for');
      assert.match(reply.error.message, /list_tabs/, 'the error does not list the tools that do exist');
    });
  });

  it('leaves isError off a call that succeeded', async () => {
    // close_own_tabs is the one tool that answers from memory: a fresh server
    // owns no tabs, so it returns early without spawning osascript and without
    // touching anybody's browser.
    await withServer(async (server) => {
      const { result, error } = await server.request('tools/call', { name: 'close_own_tabs', arguments: {} });
      assert.equal(error, undefined, `close_own_tabs failed: ${JSON.stringify(error)}`);
      assert.equal('isError' in result, false, 'a successful call must not be flagged as an error');
      const payload = payloadOf(result);
      assert.equal(payload.ok, true);
      assert.equal(payload.closed, 0);
    });
  });

  it('sets isError when a handler reports ok false, so the model can self-correct', async () => {
    // batch resolves its step names against the registry in memory, so an
    // unknown step fails without reaching Arc. This is the ok: false branch of
    // the failed() rule: the tool ran, and it ran badly.
    await withServer(async (server) => {
      const { result } = await server.request('tools/call', {
        name: 'batch',
        arguments: { steps: [{ tool: 'no_such_step' }] }
      });
      assert.equal(result.isError, true, 'a batch that failed came back unflagged');
      const payload = payloadOf(result);
      assert.equal(payload.ok, false);
      assert.equal(payload.ran, 1);
      assert.match(payload.results[0].error, /Unknown tool: no_such_step/);
    });
  });

  it('sets isError on a thrown handler and names the tool in the text', async () => {
    // wrapUserCode rejects unparseable code in Node, before anything is sent to
    // Arc, which is the cheapest way to reach the catch branch of tools/call.
    await withServer(async (server) => {
      const { result } = await server.request('tools/call', {
        name: 'execute_javascript',
        arguments: { code: 'return return' }
      });
      assert.equal(result.isError, true, 'a thrown handler came back unflagged');
      const text = result.content[0].text;
      assert.match(text, /Error in execute_javascript/, 'the error text does not say which tool failed');
      assert.match(text, /does not parse/, 'the error text does not say what was wrong');
    });
  });

  it('says an internal error is internal, rather than blaming Arc or the page', async () => {
    // An ArcError is written for the caller and explains its own remedy. A
    // TypeError from this server is a bug here, and saying so is what stops the
    // caller retrying a call that cannot start working.
    await withServer(async (server) => {
      // steps is declared as an array; a string reaches the handler and breaks
      // inside it, which is exactly the "not an Arc problem" case.
      const { result } = await server.request('tools/call', {
        name: 'batch',
        arguments: { steps: 'not-an-array' }
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /internal arc-control error/);
    });
  });
});
