// The real API returns signed `thinking` blocks next to tool calls and rejects them when echoed back.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const seen = [];
const api = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const j = JSON.parse(b); seen.push(j); res.setHeader('content-type', 'application/json');
    const hasThinking = j.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'thinking' || c.type === 'redacted_thinking'));
    if (hasThinking) { res.statusCode = 400; return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } })); }
    if (j.messages.length === 1) return res.end(JSON.stringify({ stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'thinking', thinking: 'let me look', signature: 'sig-abc' }, { type: 'redacted_thinking', data: 'xyz' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_1', name: 'fetch_url', input: { url: 'https://acme.test' } }] }));
    res.end(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 5 }, content: [{ type: 'thinking', thinking: 'done', signature: 'sig-def' }, { type: 'text', text: 'FINAL ANSWER' }] }));
  });
}).listen(0);
await new Promise((r) => api.once('listening', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${api.address().port}`;
const { LLM } = await import('../server/llm.js');
test.after(() => api.close());

test('a tool loop survives signed thinking blocks: they are not sent back, tool calls and text are', async () => {
  const l = new LLM(); l.apiKey = 'k'; l.setMode('live'); const calls = [];
  const r = await l.complete({ kind: 'work', system: 'sys', user: 'go', tools: [{ name: 'fetch_url', description: 'Fetch a page', input_schema: { type: 'object', properties: { url: { type: 'string' } } } }], onTool: async (n, i) => { calls.push([n, i]); return 'PAGE'; }, maxTurns: 3 });
  assert.equal(r.text, 'FINAL ANSWER'); assert.deepEqual(calls, [['fetch_url', { url: 'https://acme.test' }]]);
  const echoed = seen[1].messages[1]; assert.equal(echoed.role, 'assistant');
  assert.deepEqual(echoed.content.map((c) => c.type), ['text', 'tool_use'], 'only text and the tool call go back');
  assert.equal(seen[1].messages[2].content[0].tool_use_id, 'tu_1');
});
