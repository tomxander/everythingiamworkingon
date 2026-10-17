// Verifies the live-Claude path against a fake Anthropic API: request shape,
// skill injection, prompt caching marker, JSON plan parsing, usage accounting, budget cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const requests = [];
let failNext = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body);
    requests.push({ headers: req.headers, body: json, url: req.url });
    if (failNext > 0) { failNext--; res.writeHead(529, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'overloaded' } })); }
    const system = json.system.map((b) => b.text).join('\n');
    const user = json.messages[0].content;
    let text;
    if (/Open the meeting in 3 to 5 sentences/.test(user)) text = 'Team, plan understood. Owners, confirm.';
    else if (/Give your approach, anything you need from a named teammate/.test(user)) text = 'I will do my part. Risk: the baseline.';
    else if (/Write the handoff/.test(user)) text = 'Heads up: see the headline findings.';
    else if (/Find REAL conflicts/.test(user)) text = '{"conflicts":[]}';
    else if (/reflecting on work you just finished/.test(system)) text = '{"lessons":[]}';
    else if (/leading the retrospective/.test(system)) text = '{"wentWell":["ok"],"wentWrong":[],"lessons":[],"rules":[]}';
    else
    if (/Reply with JSON only/.test(user)) {
      text = 'Here is the plan:\n```json\n' + JSON.stringify({ summary: 'Research, then write.', steps: [
        { agent: 'sol', skill: 'customer-research', instruction: 'Find the language.', deps: [], consult: null },
        { agent: 'theo', skill: 'copywriting', instruction: 'Write the hero.', deps: [0], consult: 'sol' },
        { agent: 'ghost', skill: 'nonsense', instruction: 'invalid agent should be dropped', deps: [] },
      ] }) + '\n```';
    } else if (/peer review/.test(system)) text = 'Strong spine, tighten the opening. Approved with notes.';
    else if (/Synthesize the team/.test(user)) text = '# Executive summary\n\nShip it. Next 7 days: go.';
    else if (/Ask .* one short, specific question/.test(system)) text = 'What is the single proof point we can lead with?';
    else if (/Answer .* question/.test(system)) text = 'Lead with the 14-day result; cut the rest.';
    else text = '# Hero copy\n\n## Assumptions\n- B2C\n\n1. Headline: Habits that fit a parent\'s day.\n\n## Next actions\n- Ship.';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.MODEL = 'claude-sonnet-4-6'; // the default for calls that belong to nobody
const { world, run } = await import('./helpers.js');

test.after(() => fake.close());

function liveWorld() {
  const w = world();
  w.llm.apiKey = 'sk-ant-test'; w.llm.setMode('live');
  return w;
}

test('live mode: planner JSON is parsed, bad agents dropped, work is skill-grounded', async () => {
  const w = liveWorld();
  const task = w.company.submitTask({ title: 'Rewrite the hero', brief: 'Habit app for parents' });
  assert.ok(await run(w.sim, () => task.status === 'done' || task.status === 'failed', 900), 'finishes');
  assert.equal(task.status, 'done', task.error);
  assert.equal(task.subtasks.length, 2, 'the invalid "ghost" step is dropped');
  assert.deepEqual(task.subtasks[1].deps, [0]);
  assert.equal(task.subtasks[1].consult, 'sol');

  const work = requests.find((r) => /Your active skill: copywriting/.test(r.body.system.map((b) => b.text).join('')));
  assert.ok(work, 'copywriting skill text was injected into the system prompt');
  assert.equal(work.headers['x-api-key'], 'sk-ant-test');
  assert.equal(work.headers['anthropic-version'], '2023-06-01');
  assert.equal(work.body.model, 'claude-sonnet-5-5', "a person's work runs on their own model (Theo's suggestion), not the default");
  assert.ok(work.body.system.at(-1).cache_control, 'the long skill block is marked cacheable');
  assert.match(work.body.system[0].text, /4EVR/, 'charter present');
  assert.match(work.body.messages[0].content, /Habit app for parents/, 'client brief present');
  assert.match(work.body.messages[0].content, /Upstream work from teammates/);

  // downstream agent saw upstream output
  assert.match(requests.filter((r) => /Your active skill: copywriting/.test(r.body.system.map((b) => b.text).join('')))[0].body.messages[0].content, /###/);
  assert.ok(w.llm.totals.calls >= 6);
  assert.equal(w.llm.totals.simulated, false);
  assert.ok(w.llm.totals.inputTokens >= 6000 && w.llm.totals.cost > 0);
  assert.ok(w.company.deliverables.get(task.summaryId).markdown.includes('Ship it'));
  assert.ok(!w.company.deliverables.get(task.subtasks[0].outputId).simulated);
});

test('live mode: transient API errors are retried', async () => {
  const w = liveWorld();
  failNext = 1;
  const res = await w.llm.complete({ kind: 'review', system: 'You are X. peer review', user: 'text', maxTokens: 50 });
  assert.match(res.text, /Approved/);
});

test('budget cap drops the office back to simulation', async () => {
  const w = liveWorld();
  w.company.budgetCap = 0.0001;
  w.llm.account(5000, 1000);
  w.company.guardBudget();
  assert.equal(w.llm.mode, 'mock');
});

test('live mode refuses to start without a key', () => {
  const w = world(); w.llm.apiKey = '';
  assert.throws(() => w.llm.setMode('live'), /No API key/);
});
