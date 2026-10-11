#!/usr/bin/env node
// A stand-in for the `claude` CLI, driven by environment variables. Speaks just enough of the real contract:
// --version, stream-json init event, and a print-mode call that talks to a local HTTP MCP server.
import fs from 'node:fs';
const args = process.argv.slice(2); const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const list = (n) => { const i = args.indexOf(n); if (i < 0) return []; const out = []; for (let k = i + 1; k < args.length && !args[k].startsWith('--'); k++) out.push(args[k]); return out; };
if (args.includes('--version')) { console.log('2.0.0-fake (Claude Code)'); process.exit(0); }
let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (stdin += d));
if (args.includes('stream-json')) {
  const servers = JSON.parse(process.env.FAKE_SERVERS || '[]');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.0.0-fake', tools: ['Read', 'WebSearch', ...servers.flatMap((s) => s.tools.map((t) => `mcp__${s.name}__${t}`))], mcp_servers: servers.map((s) => ({ name: s.name, status: 'connected' })), plugins: [{ name: 'cc-plugin-x' }, { name: 'sales-helper' }] }));
  setInterval(() => {}, 1000); // stay alive until killed, like a session waiting for the model
} else {
  process.stdin.on('end', async () => {
    if (process.env.FAKE_HANG) return setInterval(() => {}, 1000);
    if (process.env.FAKE_FAIL === 'auth') { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })); process.exit(1); }
    let toolText = 'no tool';
    const cfg = flag('--mcp-config');
    if (cfg && process.env.FAKE_CALL) {
      const url = JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers['4evr'].url;
      const rpc = async (method, params, id = 1) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }); return r.status === 202 ? null : r.json(); };
      await rpc('initialize', { protocolVersion: '2025-03-26' }); await rpc('notifications/initialized', undefined, undefined);
      const tl = await rpc('tools/list', {}, 2);
      const call = await rpc('tools/call', { name: process.env.FAKE_CALL, arguments: JSON.parse(process.env.FAKE_CALL_ARGS || '{}') }, 3);
      toolText = `${tl.result.tools.map((t) => t.name).join(',')} => ${call.result?.content?.[0]?.text ?? JSON.stringify(call.error)}`;
    }
    const sys = fs.readFileSync(flag('--system-prompt-file'), 'utf8');
    const result = process.env.FAKE_RESULT || `ANSWER|tool:${toolText}|sys:${sys.slice(0, 30)}|allowed:${list('--allowedTools').join(' ')}|builtin:[${flag('--tools')}]|model:${flag('--model') || ''}|keyset:${process.env.ANTHROPIC_API_KEY ? 'yes' : 'no'}|user:${stdin.slice(0, 40)}`;
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 400, output_tokens: 30 }, total_cost_usd: 0.01, num_turns: 2, permission_denials: [] }));
  });
}
