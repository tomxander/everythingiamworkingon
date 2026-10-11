// The model picker: list prices drive cost estimates, and the live list comes from the Models API.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let pages = 0, fail = false; const seenHeaders = [];
const api = http.createServer((req, res) => {
  seenHeaders.push(req.headers); res.setHeader('content-type', 'application/json');
  if (fail) { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } })); }
  const u = new URL(req.url, 'http://x'); pages++;
  if (!u.searchParams.get('after_id')) return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', type: 'model' }, { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model' }], has_more: true, last_id: 'claude-opus-5-5' }));
  res.end(JSON.stringify({ data: [{ id: 'claude-experimental-x', display_name: 'Claude Experimental X', type: 'model' }], has_more: false, last_id: 'claude-experimental-x' }));
}).listen(0);
await new Promise((r) => api.once('listening', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${api.address().port}`;
delete process.env.PRICE_IN; delete process.env.PRICE_OUT; delete process.env.MODEL;
const { LLM } = await import('../server/llm.js');
const { MODEL_CATALOG, DEFAULT_MODEL } = await import('../server/models.js');
test.after(() => api.close());

test('the default is Claude Opus 5.5 and cost estimates follow the selected model\'s list price', () => {
  const l = new LLM(); assert.equal(l.model, DEFAULT_MODEL); assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
  assert.deepEqual(l.price(), { in: 4, out: 20, source: 'catalog' });
  l.account(1e6, 1e6); assert.equal(l.totals.cost, 24);
  l.setModel('claude-haiku-5-5'); l.totals.cost = 0; l.account(1e6, 1e6); assert.ok(Math.abs(l.totals.cost - 0.6) < 1e-9);
  l.setModel('claude-fable-5-1'); l.totals.cost = 0; l.account(1e6, 0, 1e6); assert.equal(l.totals.cost, 10 + 1, 'cache reads are billed at a tenth of input');
  l.setModel('some-new-model'); assert.equal(l.price().source, 'unknown');
  assert.throws(() => l.setModel('bad model id; rm -rf'), /model ID/); assert.equal(l.model, 'some-new-model');
  for (const m of MODEL_CATALOG) assert.ok(m.in > 0 && m.out > m.in, m.id);
});

test('without a key the picker shows the built-in list; with one it pages through the Models API', async () => {
  const l = new LLM(); l.apiKey = '';
  let list = await l.listModels(); assert.equal(list.length, MODEL_CATALOG.length); assert.equal(pages, 0, 'no call without a key');
  l.apiKey = 'sk-test'; list = await l.listModels();
  assert.equal(pages, 2, 'followed has_more / last_id'); assert.equal(seenHeaders[0]['x-api-key'], 'sk-test'); assert.equal(seenHeaders[0]['anthropic-version'], '2023-06-01');
  assert.deepEqual(list.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-experimental-x'], 'catalog order first, then extras; models the key lacks are left out');
  assert.equal(list[2].tier, 'other'); assert.equal(list[2].in, null);
  await l.listModels(); assert.equal(pages, 2, 'cached');
  fail = true; const l2 = new LLM(); l2.apiKey = 'bad'; list = await l2.listModels();
  assert.equal(list.length, MODEL_CATALOG.length, 'falls back to the built-in list'); assert.match(l2.status().modelsError, /invalid x-api-key/);
});
