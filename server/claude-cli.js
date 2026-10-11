// "Claude account" backend. Instead of an API key, the agents run through the installed `claude` CLI using the
// account it is logged in to. That brings the account's own tools: web search, and any connectors (MCP servers)
// the account has. The platform's own tools (fetch_url, ask_teammate, request_info, ...) are offered to the CLI
// through a small local MCP server (the bridge below), so an agent works the same way in every mode.
//
// Safety: connectors are OFF until God enables them, and only tools that look read-only are ever allowed.
// Anything that could send, create, change, delete, spend credits or run an action is refused by name.
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = () => process.env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 180000);

// ---------------------------------------------------------------- which connector tools may be used
const READ_VERBS = new Set('search get list read fetch query find describe show view lookup check count retrieve discover inspect preview summarize summarise whoami me browse select compare analyze analyse stats status outline download export discovery'.split(' '));
const RISKY = new Set('create update delete remove send write post upload merge move manage execute trigger publish reply forward modify set add insert upsert patch run deploy apply approve reject cancel archive invite share rename copy duplicate import install enable disable activate connect grant revoke purchase buy pay checkout commit push reset restore revert submit complete skip resolve enrich bulk agent match generate convert transfer assign sync log feedback vacation label labels tags rotate allow'.split(' '));
/** Read-only means: some token is a reading verb and no token is a risky one. Unknown names are refused. */
export function isReadOnlyTool(fullName) {
  const rest = String(fullName).replace(/^mcp__/, ''); const i = rest.indexOf('__'); const tool = i >= 0 ? rest.slice(i + 2) : rest;
  const tokens = tool.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => READ_VERBS.has(t)) && !tokens.some((t) => RISKY.has(t));
}
export function serverOf(fullName) { const m = String(fullName).match(/^mcp__(.+?)__/); return m ? m[1] : null; }

// ---------------------------------------------------------------- the local MCP server that carries our tools
export class McpBridge {
  constructor() { this.sessions = new Map(); this.server = null; this.port = 0; }
  async start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r)); this.port = this.server.address().port; this.server.unref();
  }
  /** Offer `tools` (Anthropic tool format) with `onTool` behind a one-off URL. The caller closes it after the call. */
  async register({ tools, onTool }) {
    await this.start(); const token = crypto.randomBytes(24).toString('hex'); const session = { tools, onTool, calls: 0, closed: false };
    this.sessions.set(token, session);
    return { url: `http://127.0.0.1:${this.port}/mcp/${token}`, session, close: () => { session.closed = true; this.sessions.delete(token); } };
  }
  handle(req, res) {
    const token = (req.url || '').split('?')[0].replace(/^\/mcp\//, ''); const s = this.sessions.get(token);
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      if (!s || req.method !== 'POST') { res.statusCode = s ? 405 : 404; return res.end(); }
      let m; try { m = JSON.parse(body); } catch { res.statusCode = 400; return res.end(); }
      const reply = (result, error) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(error ? { jsonrpc: '2.0', id: m.id, error } : { jsonrpc: '2.0', id: m.id, result })); };
      if (m.id === undefined) { res.statusCode = 202; return res.end(); } // notifications
      switch (m.method) {
        case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: '4evr', version: '1.0.0' } });
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: s.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema || { type: 'object', properties: {} } })) });
        case 'tools/call': {
          const name = m.params?.name; if (!s.tools.some((t) => t.name === name)) return reply(null, { code: -32602, message: `Unknown tool ${name}` });
          s.calls++; let out; try { out = String(await s.onTool(name, m.params?.arguments || {})); } catch (e) { return reply({ content: [{ type: 'text', text: `Tool error: ${e.message}` }], isError: true }); }
          return reply({ content: [{ type: 'text', text: out.slice(0, 30000) }] });
        }
        default: return reply(null, { code: -32601, message: 'Method not found' });
      }
    });
  }
  stop() { this.server?.close(); this.server = null; }
}

// ---------------------------------------------------------------- the CLI
export class ClaudeCli {
  constructor({ concurrency = Number(process.env.CLI_CONCURRENCY || 3) } = {}) { this.concurrency = concurrency; this.active = 0; this.queue = []; this.version = null; }

  async slot() { if (this.active < this.concurrency) { this.active++; return; } await new Promise((r) => this.queue.push(r)); this.active++; }
  release() { this.active--; this.queue.shift()?.(); }

  childEnv() { const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; return env; } // use the account login, not an API key

  /** { ok, version } or { ok:false, error }. */
  available() {
    return new Promise((resolve) => {
      let out = '', done = false; const finish = (r) => { if (!done) { done = true; resolve(r); } };
      let p; try { p = spawn(BIN(), ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: this.childEnv() }); } catch (e) { return finish({ ok: false, error: e.message }); }
      p.stdout.on('data', (d) => (out += d)); p.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? 'The `claude` command was not found. Install Claude Code and sign in with your account.' : e.message }));
      p.on('close', (c) => { this.version = out.trim() || null; finish(c === 0 && out.trim() ? { ok: true, version: out.trim() } : { ok: false, error: 'The `claude` command did not run.' }); });
      setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish({ ok: false, error: 'The `claude` command timed out.' }); }, 15000);
    });
  }

  /**
   * One non-interactive call. `allowed`: tool names the call may use. `mcp`: { url } of our bridge, if any.
   * `builtin`: which built-in tools exist at all ('' for none, 'WebSearch').
   */
  async run({ system, user, model, allowed = [], mcp = null, builtin = '', maxTurns = 4, timeoutMs = TIMEOUT_MS }) {
    this.lastModel = model; await this.slot(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4evr-cli-'));
    try {
      fs.writeFileSync(path.join(dir, 'system.txt'), system || 'You are a helpful assistant.');
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--permission-mode', 'dontAsk', '--max-turns', String(maxTurns), '--system-prompt-file', path.join(dir, 'system.txt'), '--tools', builtin];
      if (model) args.push('--model', model);
      if (mcp) { fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { '4evr': { type: 'http', url: mcp.url } } })); args.push('--mcp-config', path.join(dir, 'mcp.json')); }
      if (allowed.length) args.push('--allowedTools', ...allowed);
      const { stdout, stderr, code, timedOut } = await this.spawnRun(args, user, dir, timeoutMs);
      if (timedOut) throw new Error(`The Claude CLI did not answer within ${Math.round(timeoutMs / 1000)}s.`);
      let j; try { j = JSON.parse(stdout); } catch { j = null; }
      if (!j) throw new Error(this.explain(stderr || stdout, code));
      if (j.is_error || /^error/.test(j.subtype || '')) throw new Error(this.explain(j.result || j.subtype, code));
      const u = j.usage || {};
      return { text: String(j.result || '').trim(), usage: { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 }, cost: j.total_cost_usd || 0, turns: j.num_turns || 1, denials: j.permission_denials || [] };
    } finally { this.release(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
  }

  explain(text, code) {
    const t = String(text || '').slice(0, 400);
    if (/not logged in|please run \/login|authenticat|credential|oauth|401/i.test(t)) return 'The Claude CLI is not signed in. Run `claude` once in a terminal and sign in with your account, then try again.';
    if (/unknown option|unrecognized option|unknown argument|invalid option|invalid value for/i.test(t)) return `Your installed Claude Code does not support an option this mode needs (${t.slice(0, 160)}). Update it with: npm install -g @anthropic-ai/claude-code@latest`;
    if (/model.*(not found|does not exist|invalid)|not_found/i.test(t)) return `The model "${this.lastModel || 'configured model'}" is not available to this account: ${t.slice(0, 200)}. Set a different one in Settings.`;
    if (/rate limit|usage limit|limit reached|overloaded/i.test(t)) return `Your Claude account hit a usage limit: ${t}`;
    return `The Claude CLI failed (exit ${code}): ${t || 'no output'}`;
  }

  spawnRun(args, input, cwd, timeoutMs) {
    return new Promise((resolve, reject) => {
      let out = '', err = '', timedOut = false; let p;
      try { p = spawn(BIN(), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.childEnv() }); } catch (e) { return reject(e); }
      const timer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
      p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'The `claude` command was not found. Install Claude Code and sign in with your account.' : e.message)); });
      p.on('close', (code) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code, timedOut }); });
      p.stdin.on('error', () => {}); p.stdin.end(input || '');
    });
  }

  /**
   * Ask the CLI what tools this account has: start a session, read its init event, stop before any model call is made.
   * Returns { version, servers: [{ name, status, tools: [{ name, readOnly }] }] }.
   */
  async probe({ timeoutMs = 60000 } = {}) {
    await this.slot(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4evr-cli-'));
    try {
      const init = await new Promise((resolve, reject) => {
        let buf = '', done = false; let p;
        const finish = (v, e) => { if (done) return; done = true; clearTimeout(timer); try { p.kill('SIGKILL'); } catch { /* gone */ } e ? reject(e) : resolve(v); };
        try { p = spawn(BIN(), ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'dontAsk', '--max-turns', '1'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: this.childEnv() }); } catch (e) { return reject(e); }
        const timer = setTimeout(() => finish(null, new Error('The Claude CLI did not report its tools in time.')), timeoutMs);
        p.stdout.on('data', (d) => { buf += d; for (const line of buf.split('\n')) { if (!line.trim()) continue; try { const j = JSON.parse(line); if (j.type === 'system' && j.subtype === 'init') return finish(j); } catch { /* partial line */ } } });
        p.on('error', (e) => finish(null, e)); p.on('close', () => finish(null, new Error('The Claude CLI exited before reporting its tools.')));
        p.stdin.on('error', () => {}); p.stdin.end('hi');
      });
      const byServer = new Map();
      for (const s of init.mcp_servers || []) byServer.set(s.name, { name: s.name, status: s.status || 'unknown', tools: [] });
      for (const t of init.tools || []) { const sv = serverOf(t); if (!sv || sv === '4evr') continue; if (!byServer.has(sv)) byServer.set(sv, { name: sv, status: 'connected', tools: [] }); byServer.get(sv).tools.push({ name: t, readOnly: isReadOnlyTool(t) }); }
      return { version: init.claude_code_version || null, servers: [...byServer.values()], plugins: (init.plugins || []).map((p) => p.name).filter((n) => !/^cc-plugin/.test(n)) };
    } finally { this.release(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
  }
}
