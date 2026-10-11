// "Claude account" mode: the agents run through the Claude CLI, our tools travel over a local MCP bridge,
// connectors are opt-in and read-only, and requests are looked up in connected tools first.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_BIN = path.join(here, 'fake-claude.mjs');
const { LLM } = await import('../server/llm.js');
const { McpBridge, isReadOnlyTool } = await import('../server/claude-cli.js');
const { world } = await import('./helpers.js');

const SERVERS = [{ name: 'Notion', tools: ['notion-search', 'notion-fetch', 'notion-create-pages', 'notion-update-page'] }, { name: 'Mailer', tools: ['send_mail', 'delete_thread'] }];
const ready = async () => { process.env.FAKE_SERVERS = JSON.stringify(SERVERS); const l = new LLM(); await l.cliCheck(); l.setMode('cli'); return l; };
const reset = () => { for (const k of ['FAKE_CALL', 'FAKE_CALL_ARGS', 'FAKE_RESULT', 'FAKE_FAIL', 'FAKE_HANG']) delete process.env[k]; };

test('the CLI is detected, and the mode cannot be switched on until it is', async () => {
  reset(); const l = new LLM(); assert.throws(() => l.setMode('cli'), /not been checked/);
  const s = await l.cliCheck(); assert.equal(s.available, true); assert.match(s.version, /2\.0\.0-fake/);
  l.setMode('cli'); assert.equal(l.mode, 'cli'); assert.equal(l.status().mode, 'cli');
  const saved = process.env.CLAUDE_BIN; process.env.CLAUDE_BIN = '/nonexistent/claude';
  const l2 = new LLM(); const s2 = await l2.cliCheck(); assert.equal(s2.available, false); assert.match(s2.error, /not found/); assert.throws(() => l2.setMode('cli'), /not found/);
  process.env.CLAUDE_BIN = saved;
});

test('an agent call uses the account login (no API key), our tools over the bridge, and WebSearch', async () => {
  reset(); process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak'; const l = await ready();
  process.env.FAKE_CALL = 'fetch_url'; process.env.FAKE_CALL_ARGS = JSON.stringify({ url: 'https://acme.test' });
  const seen = [];
  const r = await l.complete({ kind: 'work', system: ['You are Rafa at 4EVR.', 'More system.'], user: 'Audit the site please', tools: [{ name: 'fetch_url', description: 'Fetch', input_schema: { type: 'object', properties: { url: { type: 'string' } } } }, { name: 'ask_teammate', description: 'Ask', input_schema: { type: 'object', properties: {} } }], onTool: async (n, i) => { seen.push([n, i]); return 'PAGE TEXT'; }, maxTurns: 3 });
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(seen, [['fetch_url', { url: 'https://acme.test' }]]);
  assert.match(r.text, /tool:fetch_url,ask_teammate => PAGE TEXT/); assert.match(r.text, /sys:You are Rafa at 4EVR\./); assert.match(r.text, /allowed:WebSearch mcp__4evr\|/);
  assert.match(r.text, /builtin:\[WebSearch\]/); assert.match(r.text, /keyset:no/); assert.match(r.text, /user:Audit the site/); assert.match(r.text, new RegExp(`model:${l.model}`));
  assert.equal(r.toolCalls, 1); assert.equal(r.simulated, false); assert.equal(r.usage.input, 150); assert.equal(r.usage.output, 30); assert.equal(l.totals.cacheReadTokens, 400); assert.ok(l.totals.calls === 1);
});

test('a call with no tools gets no tools at all', async () => {
  reset(); const l = await ready();
  const r = await l.complete({ kind: 'plan', system: 'Plan.', user: 'Go' });
  assert.match(r.text, /builtin:\[\]/); assert.match(r.text, /allowed:\|/); assert.equal(r.toolCalls, 0);
});

test('connectors: discovered, off by default, only read-only tools are ever allowed, risky ones cannot be enabled', async () => {
  reset(); const l = await ready(); const s = await l.cliScan();
  const notion = s.servers.find((x) => x.name === 'Notion'), mail = s.servers.find((x) => x.name === 'Mailer');
  assert.deepEqual(notion.readOnlyTools, ['mcp__Notion__notion-search', 'mcp__Notion__notion-fetch']); assert.equal(notion.blockedTools, 2); assert.equal(notion.enabled, false);
  assert.equal(mail.readOnlyTools.length, 0); assert.deepEqual(s.plugins, ['sales-helper']);
  assert.throws(() => l.setCliConnector('Mailer', true), /no read-only tools/); assert.throws(() => l.setCliConnector('Nope', true), /Unknown connector/);
  const tools = [{ name: 'fetch_url', description: 'x', input_schema: { type: 'object' } }];
  let r = await l.complete({ kind: 'work', system: 's', user: 'u', tools, onTool: async () => 'x' });
  assert.doesNotMatch(r.text, /notion/i, 'off by default');
  l.setCliConnector('Notion', true);
  r = await l.complete({ kind: 'work', system: 's', user: 'u', tools, onTool: async () => 'x' });
  assert.match(r.text, /allowed:WebSearch mcp__4evr mcp__Notion__notion-search mcp__Notion__notion-fetch\|/); assert.doesNotMatch(r.text, /create-pages|update-page|send_mail/);
  l.setCliConnector('Notion', false); assert.equal(l.cliAllowedConnectorTools().length, 0);
});

test('read-only classification is conservative', () => {
  for (const ok of ['mcp__Notion__notion-search', 'mcp__Zoho_CRM__getRecords', 'mcp__Microsoft_365__outlook_email_search', 'mcp__X__list_demos', 'mcp__X__get_account']) assert.ok(isReadOnlyTool(ok), ok);
  for (const no of ['mcp__Notion__notion-create-pages', 'mcp__M__outlook_send_mail', 'mcp__Zoho_CRM__deleteRecord', 'mcp__Zoho_CRM__executeCOQLQuery', 'mcp__A__apollo_agent_find_prospects', 'mcp__X__pdf_viewer', 'mcp__X__manage_dashboards', 'mcp__X__create_checkout_link']) assert.ok(!isReadOnlyTool(no), no);
});

test('sign-in and timeout failures are explained, not swallowed', async () => {
  reset(); const l = await ready(); process.env.FAKE_FAIL = 'auth';
  await assert.rejects(l.complete({ kind: 'plan', system: 's', user: 'u' }), /not signed in/); assert.match(l.lastError, /not signed in/);
  reset(); process.env.FAKE_HANG = '1';
  await assert.rejects(l.cli.run({ system: 's', user: 'u', timeoutMs: 400 }), /did not answer within/);
});

test('the bridge refuses unknown or closed sessions and unknown tools', async () => {
  const b = new McpBridge(); const s = await b.register({ tools: [{ name: 'a', description: 'd', input_schema: { type: 'object' } }], onTool: async () => 'ok' });
  const call = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  assert.equal((await call(s.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zzz' } })).json.error.code, -32602);
  assert.equal((await call(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'a', arguments: {} } })).json.result.content[0].text, 'ok');
  assert.equal((await call(s.url.replace(/mcp\/.*/, 'mcp/wrongtoken'), { jsonrpc: '2.0', id: 3, method: 'ping' })).status, 404);
  assert.equal((await fetch(s.url)).status, 405);
  s.close(); assert.equal((await call(s.url, { jsonrpc: '2.0', id: 4, method: 'ping' })).status, 404); b.stop();
});

test('a request is looked up in connected tools first; found data answers it with its source, a miss leaves it open', async () => {
  reset(); const w = world(); const l = await ready(); w.company.llm = l; await l.cliScan(); l.setCliConnector('Notion', true);
  const t = { id: 'T7', title: 'Leads', brief: 'B2B', subtasks: [] }; w.company.tasks.set('T7', t); const a = w.company.agent('dee');
  process.env.FAKE_RESULT = JSON.stringify({ found: true, answer: 'Sessions last 90 days: 12,400. Leads: 310. Source split: organic 41%, paid 22%.', source: 'Notion page "Q3 analytics"' });
  const r1 = w.company.raiseRequest(t, a, { kind: 'data', what: 'Last 90 days of analytics by source', why: 'baseline', tried: 'searched the web' }).req;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(r1.status, 'answered'); assert.equal(r1.auto, true); assert.match(r1.answer.by, /connector: Notion page/); assert.match(w.company.requestsText(t), /12,400/);
  process.env.FAKE_RESULT = JSON.stringify({ found: false });
  const r2 = w.company.raiseRequest(t, a, { kind: 'document', what: 'Brand voice guide document', why: 'copy', tried: 'searched the web' }).req;
  await new Promise((r) => setTimeout(r, 1500)); assert.equal(r2.status, 'open');
  l.setCliConnector('Notion', false); process.env.FAKE_RESULT = JSON.stringify({ found: true, answer: 'x'.repeat(50), source: 's' });
  const r3 = w.company.raiseRequest(t, a, { kind: 'question', what: 'Which competitors do you lose deals to?', why: 'x', tried: 'searched the web' }).req;
  await new Promise((r) => setTimeout(r, 800)); assert.equal(r3.status, 'open', 'no lookup when connectors are off');
  reset();
});
