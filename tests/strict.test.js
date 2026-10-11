// Full tasks against a fake API that is as strict as the real one, with thinking blocks and tool calls on every reply.
// This is the test that would have caught the "Invalid signature in thinking block" and "must define tools" failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { strictApi, validate } from './strict-api.js';
process.env.ALLOW_PRIVATE_FETCH = '1'; process.env.SEARCH_GAP_MS = '0';

const web = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<div class="result"><a class="result__a" href="https://acsia.example/">Acsia Technologies</a><a class="result__snippet">Automotive software</a></div><title>Acsia</title><h1>Acsia</h1>'); });
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const W = `http://127.0.0.1:${web.address().port}`;
process.env.SEARCH_ENDPOINT = `${W}/s?q={q}`; for (const k of ['NEWS', 'WIKI', 'REDDIT', 'HN']) process.env[`SEARCH_${k}_ENDPOINT`] = `${W}/gone?q={q}`;

const reply = (body) => {
  const sys = JSON.stringify(body.system || '');
  if (/writing the intake brief/.test(sys)) return JSON.stringify({ objective: 'Understand Acsia Technologies before the engagement', goalType: 'strategy', metric: 'Verified facts', target: 'Not specified', timeframe: '2 weeks', budget: 'Not specified', audience: 'OEM buyers', constraints: [], assumptions: ['No site given'], openQuestions: ['Which markets matter most?'] });
  if (/turn God's request into a plan/.test(sys)) return JSON.stringify({ summary: 'Research Acsia', hires: [], steps: [{ agent: 'sol', skill: 'customer-research', instruction: 'Who buys from Acsia', deps: [], consult: null }, { agent: 'sol', skill: 'competitors', instruction: 'Competitive landscape', deps: [], consult: null }, { agent: 'indigo', skill: 'offers', instruction: 'Core offer', deps: [0], consult: null }, { agent: 'priya', skill: 'content-strategy', instruction: 'Content pillars', deps: [1], consult: null }] });
  if (/peer review/.test(sys)) return JSON.stringify({ verdict: 'revise', strength: 'Specific.', improvement: 'Cite the source for the market claim.' });
  return '# Deliverable\n\n## Assumptions\n- No site given\n\n## Work\nSpecific work for Acsia.\n\n## Next actions\n- Do the thing\n\n## How we will know it worked\n- The metric moves';
};
const api = await strictApi({ reply, toolRounds: 3, toolInput: (name) => ({ fetch_url: { url: `${W}/page` }, web_search: { query: 'Acsia Technologies', source: 'web' }, ask_teammate: { to: 'rafa', question: 'Any SEO angle?' }, request_info: { kind: 'data', what: 'Last 90 days of analytics by source', why: 'baseline', tried: 'Searched the web, nothing public.' }, request_hire: { role: 'x', need: 'x', why: 'x' }, read_skill_reference: { file: 'nothing.md' }, save_lesson: { text: 'Cite sources.' }, recall_lessons: { topic: 'x' } })[name] || {} });
process.env.ANTHROPIC_BASE_URL = api.url;
const { world } = await import('./helpers.js');
test.after(() => { api.close(); web.close(); });

async function runLive(title, ms = 90000) {
  const w = world({ outside: true }); w.llm.apiKey = 'k'; w.llm.setMode('live'); w.company.hiringMode = 'off';
  const t = w.company.submitTask({ title, brief: '' });
  const end = Date.now() + ms; while (Date.now() < end && !['done', 'failed'].includes(t.status)) { w.sim.tick(0.1); await new Promise((r) => setTimeout(r, 10)); }
  return { w, t };
}

test('the strict fake really rejects what the real API rejects', () => {
  assert.match(validate({ max_tokens: 10, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'a', signature: 's' }, { type: 'tool_use', id: '1', name: 'a', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'r' }] }], tools: [{ name: 'a', input_schema: { type: 'object' } }] })[0], /Invalid `signature`/);
  assert.match(validate({ max_tokens: 10, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'a', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'r' }] }] })[0], /must define tools/);
  assert.match(validate({ max_tokens: 10, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'a', input: {} }] }, { role: 'user', content: 'no result' }], tools: [{ name: 'a', input_schema: { type: 'object' } }] }).join(), /without tool_result/);
  assert.deepEqual(validate({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }), []);
});

test('a whole live task runs against the strict API: thinking blocks, repeated tool calls, budgets, reviews, revisions', async () => {
  const { w, t } = await runLive('Learn about Acsia Technologies Pvt. Ltd. We will be getting them as a client soon.');
  assert.deepEqual([...new Set(api.state.violations)], [], 'no request broke the API rules');
  assert.equal(t.status, 'done', `${t.error || ''} ${JSON.stringify(t.warnings)}`);
  assert.ok(!(t.warnings || []).length, `no fallbacks: ${JSON.stringify(t.warnings)}`);
  assert.equal(t.intake.objective, 'Understand Acsia Technologies before the engagement');
  assert.ok(t.subtasks.length === 4 && t.subtasks.every((s) => s.status === 'done'));
  assert.ok(api.state.toolCalls > 10, `tools were really used (${api.state.toolCalls})`);
  assert.ok(t.subtasks.some((s) => s.revised), 'a review asked for a revision and it went through');
  assert.ok(w.company.requestsPublic().some((r) => r.taskId === t.id && r.origin === 'agent'), 'request_info worked through the loop');
});

test('retrying a failed task starts clean', async () => {
  const w = world(); const t = w.company.submitTask({ title: 'Learn about Acsia', brief: '' });
  Object.assign(t, { status: 'failed', error: 'old', warnings: ['old warning'], meetings: [{ type: 'kickoff' }], decisions: [{ issue: 'x' }], thread: [{ text: 'x' }], expertConsults: 3, summaryId: 'D1' });
  w.company.retryTask(t.id);
  assert.deepEqual([t.warnings, t.meetings, t.decisions, t.thread, t.expertConsults, t.summaryId, t.error], [[], [], [], [], 0, null, null]);
  assert.equal(t.retried, 1);
});
