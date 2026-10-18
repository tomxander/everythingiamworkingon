// A task must never sit in "planning" without a way out, and a fallback must be visible on the task itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.API_TIMEOUT_MS = '400'; process.env.INTAKE_TIMEOUT_S = '0.4'; process.env.PLAN_TIMEOUT_S = '0.4';
process.env.TEST_TIMEOUT_S = '2'; process.env.ALLOW_PRIVATE_FETCH = '1'; process.env.SEARCH_GAP_MS = '0';

let behaviour = 'hang'; const bodies = [];
const api = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const j = JSON.parse(b || '{}'); bodies.push(j); const sys = JSON.stringify(j.system || '');
    if (behaviour === 'hang') return; // never answers
    if (behaviour === 'dead') { res.statusCode = 401; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } })); }
    const reply = (text) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } })); };
    if (/writing the intake brief/.test(sys)) {
      if (behaviour === 'prose' && j.tools) return reply('I looked into Northwind Components. It is a components maker. Here is my thinking about the objective and what to ask.');
      return reply(JSON.stringify({ objective: 'Understand Northwind Components before the engagement starts', goalType: 'strategy', metric: 'Verified facts about the client', target: 'Not specified', timeframe: '2 weeks', budget: 'Not specified', audience: 'OEM buyers', constraints: [], assumptions: ['Site not read'], openQuestions: ['Which markets matter most?'] }));
    }
    reply('not json at all'); // plan, work, reviews: unusable
  });
}).listen(0);
await new Promise((r) => api.once('listening', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${api.address().port}`;
const { world } = await import('./helpers.js');
test.after(() => { api.closeAllConnections?.(); api.close(); });

const live = () => { const w = world(); w.llm.apiKey = 'sk-ant-test'; w.llm.setMode('live'); return w; };
async function untilPlanned(w, t, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end && !t.subtasks.length) { w.sim.tick(0.1); await new Promise((r) => setTimeout(r, 20)); } return t.subtasks.length > 0; }

test('when the model never answers, planning gives up on a deadline, falls back to a playbook, and says so on the task', async () => {
  behaviour = 'hang'; const w = live(); const toasts = [];
  w.company.on('broadcast', (m) => m.type === 'toast' && toasts.push(m.text));
  const t = w.company.submitTask({ title: 'Learn about Northwind Components Ltd. We will be getting them as a client soon.', brief: '' });
  assert.ok(await untilPlanned(w, t), 'planning finished instead of hanging');
  assert.ok(t.subtasks.length >= 3, 'the playbook plan has workstreams');
  assert.ok(t.warnings.some((x) => /intake call failed/i.test(x) && /did not answer/.test(x)), t.warnings.join(' | '));
  assert.ok(t.warnings.some((x) => /Planning failed/.test(x)), t.warnings.join(' | '));
  assert.ok(t.intake.objective, 'a fallback brief still exists');
  assert.ok(w.company.publicTask(t).warnings.length >= 2, 'the UI receives the warnings');
});

test('an intake answered in prose is retried once, plainly, and the model\'s real brief is used', async () => {
  behaviour = 'prose'; bodies.length = 0; const w = live();
  const t = w.company.submitTask({ title: 'Learn about Northwind Components Ltd.', brief: '' });
  assert.ok(await untilPlanned(w, t));
  assert.equal(t.intake.objective, 'Understand Northwind Components before the engagement starts');
  const intakeCalls = bodies.filter((b) => /writing the intake brief/.test(JSON.stringify(b.system)));
  assert.equal(intakeCalls.length, 2); assert.ok(intakeCalls[0].tools && !intakeCalls[1].tools, 'the retry has no tools');
  assert.match(intakeCalls[1].messages[0].content, /JSON object only/);
  assert.ok(!(t.warnings || []).some((x) => /intake/i.test(x)), 'no warning once the retry worked');
});

test('when every workstream fails, the card says why and runs a connection test instead of just "failed"', async () => {
  behaviour = 'dead'; const w = live();
  const t = w.company.submitTask({ title: 'Learn about Northwind Components Ltd.', brief: '' });
  const end = Date.now() + 60000; while (Date.now() < end && t.status !== 'failed') { w.sim.tick(0.1); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(t.status, 'failed');
  assert.ok(t.subtasks.length && t.subtasks.every((s) => s.status === 'failed' && s.error), 'each workstream carries an error');
  assert.ok(t.subtasks.some((s) => /invalid x-api-key/.test(s.error)), 'the real cause is on the workstreams that ran');
  assert.match(t.error, /All workstreams failed/); assert.match(t.error, /Most common error: .*invalid x-api-key/); assert.match(t.error, /Connection test: .*invalid x-api-key/);
  assert.ok(t.warnings.some((x) => /intake call failed/i.test(x)));
});

test('the connection test passes on a working model and reports exactly what is wrong otherwise', async () => {
  const w = live(); behaviour = 'dead'; let r = await w.llm.test(); assert.equal(r.ok, false); assert.match(r.error, /invalid x-api-key/);
  behaviour = 'ok-pong'; const orig = api.listeners('request')[0]; api.removeAllListeners('request');
  api.on('request', (req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 5, output_tokens: 1 } })); }); });
  r = await w.llm.test(); assert.equal(r.ok, true); assert.match(r.text, /Connected/);
  api.removeAllListeners('request'); api.on('request', orig);
  const m = world(); assert.equal((await m.llm.test()).simulated, true);
});
