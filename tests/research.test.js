// The "go to example.com and get them more leads" scenarios: reading the site, intake,
// tool use, truncation recovery, review-driven revision, timeouts, unreachable sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.ALLOW_PRIVATE_FETCH = '1';
process.env.API_TIMEOUT_MS = '400';

// ---- a tiny client website
const PAGES = {
  '/': '<title>Acme Cables | Custom assemblies</title><meta name="description" content="Cable assemblies."><h1>Cables that do not fail</h1><nav><a href="/contact">Contact</a><a href="/products">Products</a></nav><a href="/contact">Request a quote</a><p>We build custom cable assemblies for OEMs worldwide and have done so for twenty years.</p>',
  '/contact': '<title>Contact</title><h1>Contact</h1><form><input name="name"><input name="email"><input name="company"><input name="phone"><input name="a"><input name="b"></form>',
  '/products': '<title>Products</title><h1>Products</h1><p>Harnesses.</p>',
};
const site = http.createServer((q, r) => { const b = PAGES[q.url.split('?')[0]]; if (!b) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': 'text/html' }); r.end(b); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

// ---- a fake Anthropic API with scripted behaviours
const seen = [];
const state = { continued: false, rafaToolDone: false };
const api = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw); seen.push(body);
    const system = body.system.map((b) => b.text).join('\n');
    const msgs = body.messages; const first = typeof msgs[0].content === 'string' ? msgs[0].content : '';
    const lastUser = msgs.at(-1);
    const send = (text, extra = {}) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 800, output_tokens: 150 }, stop_reason: 'end_turn', ...extra })); };
    if (/HANG/.test(first)) return; // never answers
    // team-conversation prompts: answer them plainly so they never get mistaken for work calls
    if (/Open the meeting in 3 to 5 sentences/.test(first)) return send('Team, here is the plan. Owners, confirm.');
    if (/Give your approach, anything you need from a named teammate/.test(first)) return send('I will do my part and need nothing urgent. Risk: the baseline.');
    if (/Write the handoff/.test(first)) return send('Heads up: see the headline findings. I assumed the brief.');
    if (/Find REAL conflicts/.test(first)) return send('{"conflicts":[]}');
    if (/reflecting on work you just finished/.test(system)) return send('{"lessons":[]}');
    if (/leading the retrospective/.test(system)) return send('{"wentWell":["ok"],"wentWrong":[],"lessons":[],"rules":[]}');
    if (/finalising a hire/.test(system)) return send('{"first":"Test","last":"Hire","persona":"A careful specialist.","quirks":["Check it."]}');
    if (/Reply with JSON only:\n\{"objective"/.test(first)) return send(JSON.stringify({ objective: 'Increase qualified quote requests from the Acme Cables website', goalType: 'leadgen', metric: 'Quote requests per month', target: '40 per month', timeframe: '90 days', budget: 'Not specified', audience: 'OEM buyers', constraints: ['No site access'], assumptions: ['Baseline unknown'], openQuestions: ['What is the current monthly quote volume?'] }));
    if (/Reply with JSON only/.test(first) && /steps/.test(first)) return send(JSON.stringify({ summary: 'Fix the lead path then measure it.', steps: [{ agent: 'rafa', skill: 'seo-audit', instruction: 'Audit the key pages.', deps: [] }, { agent: 'theo', skill: 'copywriting', instruction: 'Rewrite the hero.', deps: [] }] }));
    if (/Build the client profile/.test(first)) return send('# Client profile: Acme\n\n- Offers custom cable assemblies (see /).\n\n## Not verified\n- Traffic, conversion.');
    if (/peer review/.test(system)) return send(/RAFA-DRAFT/.test(first) ? JSON.stringify({ verdict: 'revise', strength: 'Good structure.', improvement: 'The audit never cites a real page URL.' }) : JSON.stringify({ verdict: 'approve', strength: 'Clear.', improvement: 'Tighten.' }));
    if (/Synthesize the team/.test(first)) return send('# Executive summary\n\nDone.\n\n## Open questions for God\n- Baseline?');
    if (/one short, specific question/.test(system) || /Answer .* question/.test(system)) return send('Ok.');
    if (/Here is your deliverable and a reviewer/.test(first)) return send('# SEO audit (revised)\n\n## Assumptions\n- Pages read.\n\n1. The contact form at ' + SITE + '/contact has 6 fields; cut to 3.\n\n## Next actions\n- Ship it. This revised version is intentionally long enough to replace the draft because it is longer than half of the original draft text. '.repeat(3));
    // work calls
    if (/You were cut off/.test(typeof lastUser.content === 'string' ? lastUser.content : '')) return send(' PART2 end.');
    if (/Rewrite the hero/.test(first) && /Rules for this deliverable/.test(first) && !state.continued) { state.continued = true; return send('# Hero copy\n\nPART1 start', { stop_reason: 'max_tokens' }); }
    if (/Audit the key pages/.test(first) && /Rules for this deliverable/.test(first)) {
      const hasResult = Array.isArray(lastUser.content) && lastUser.content.some((c) => c.type === 'tool_result');
      if (!hasResult) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ content: [{ type: 'text', text: 'Let me read the contact page.' }, { type: 'tool_use', id: 'tu_1', name: 'fetch_url', input: { url: `${SITE}/contact` } }], usage: { input_tokens: 800, output_tokens: 60 }, stop_reason: 'tool_use' })); }
      const got = lastUser.content[0].content;
      return send(`# SEO audit\n\nRAFA-DRAFT\n\n## Assumptions\n- ok\n\nThe tool returned: ${/6 fields/.test(got) ? 'a form with 6 fields' : 'nothing useful'}.`);
    }
    return send('# Deliverable\n\n1. Something.');
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${api.address().port}`;
const { world, run } = await import('./helpers.js');
const { LLM } = await import('../server/llm.js');
test.after(() => { site.close(); api.close(); });

const liveWorld = () => { const w = world(); w.llm.apiKey = 'sk-ant-test'; w.llm.setMode('live'); return w; };

test('the exact failing instruction is routed to inbound lead generation, not cold email', async () => {
  const w = world();
  const t = w.company.submitTask({ title: `go to ${SITE} and make them get more leads`, brief: '' });
  await run(w.sim, () => ['done', 'failed'].includes(t.status), 1500);
  assert.equal(t.status, 'done', t.error);
  assert.equal(t.intake.goalType, 'leadgen');
  const agents = t.subtasks.map((s) => `${s.agent}/${s.skill}`).join();
  assert.match(agents, /nadia\/cro/); assert.match(agents, /dee\/analytics/);
  assert.doesNotMatch(agents, /cold-email|prospecting/);
});

test('the site is actually read, shared with every agent, and cited in deliverables', async () => {
  const w = world();
  const t = w.company.submitTask({ title: `Get ${SITE} more leads`, brief: 'B2B cable maker' });
  await run(w.sim, () => ['done', 'failed'].includes(t.status), 1500);
  assert.equal(t.sources[0].pages.length, 3, 'home, contact, products');
  assert.ok(t.profileId, 'a client profile deliverable was produced');
  const evidence = w.company.deliverables.get(t.subtasks[0].outputId).markdown;
  assert.match(evidence, /Evidence from the site/); assert.match(evidence, /Request a quote/); assert.match(evidence, /6 fields/);
  assert.match(w.company.contextText(t), /Sources read for 127\.0\.0\.1/);
  assert.ok(w.company.clients.size === 1, 'the client is remembered for next time');
  // second task for the same client reuses the cached read instead of re-crawling
  const t2 = w.company.submitTask({ title: `Audit SEO for ${SITE}`, brief: '' });
  await run(w.sim, () => ['done', 'failed'].includes(t2.status), 1500);
  assert.equal(t2.sources[0].cached, true);
});

test('an unreachable site is reported honestly, and nothing about it is presented as fact', async () => {
  const w = world(); const toasts = [];
  w.company.on('broadcast', (m) => { if (m.type === 'toast') toasts.push(m.text); });
  const t = w.company.submitTask({ title: 'Get http://127.0.0.1:1 more leads', brief: '' });
  await run(w.sim, () => ['done', 'failed'].includes(t.status), 1500);
  assert.equal(t.status, 'done', 'the work still proceeds');
  assert.equal(t.sources[0].pages.length, 0);
  assert.ok(toasts.some((x) => /Could not read/.test(x)));
  assert.match(w.company.contextText(t), /could not be read[\s\S]*Not verified/i);
  assert.ok(!w.company.deliverables.get(t.subtasks[0].outputId).markdown.includes('Evidence from the site'));
  assert.ok(w.company.comms.some((c) => /could not open/i.test(c.text)));
});

test('live: intake, profile, tool use, truncation recovery and review-driven revision', async () => {
  const w = liveWorld();
  const t = w.company.submitTask({ title: `go to ${SITE} and get them more leads`, brief: '' });
  assert.ok(await run(w.sim, () => ['done', 'failed'].includes(t.status), 3000), `finishes (${t.status})`);
  assert.equal(t.status, 'done', t.error);
  assert.equal(t.intake.objective, 'Increase qualified quote requests from the Acme Cables website');
  assert.equal(t.intake.target, '40 per month');
  assert.match(w.company.clients.get('127.0.0.1').profile, /Not verified/);

  // the worker prompts carry the shared context and rules
  const rafaCalls = seen.filter((b) => /Audit the key pages/.test(String(b.messages[0].content)) && /Rules for this deliverable/.test(String(b.messages[0].content)));
  assert.ok(rafaCalls.length >= 2, 'tool loop made a follow-up call');
  const sys = rafaCalls[0].system.map((x) => x.text).join('');
  assert.match(sys, /Client context/); assert.match(sys, /Quote requests per month/); assert.match(sys, /Sources read for 127\.0\.0\.1/);
  assert.ok(rafaCalls[0].tools.some((x) => x.name === 'fetch_url'), 'agents are offered the web tool');
  const toolResult = rafaCalls.find((b) => Array.isArray(b.messages.at(-1).content));
  assert.match(toolResult.messages.at(-1).content[0].content, /6 fields/, 'the page was really fetched and returned to the model');

  // truncated answer was continued
  const hero = [...w.company.deliverables.values()].find((d) => /PART1/.test(d.markdown));
  assert.ok(hero && /PART2/.test(hero.markdown), 'the cut-off answer was continued');

  // reviewer asked for a revision, the author revised once, the deliverable was replaced
  const rafa = t.subtasks.find((s) => s.agent === 'rafa');
  assert.equal(rafa.review.verdict, 'revise'); assert.equal(rafa.revised, true);
  const d = w.company.deliverables.get(rafa.outputId);
  assert.match(d.markdown, /revised/); assert.ok(d.revised);
  assert.ok(w.company.comms.some((c) => /Revising after review/.test(c.text)));
  // summary mentions open questions
  assert.match(w.company.deliverables.get(t.summaryId).markdown, /Open questions/);
});

test('an API call that hangs fails with a clear message instead of freezing the agent', async () => {
  const llm = new LLM(); llm.apiKey = 'k'; llm.setMode('live');
  const started = Date.now();
  await assert.rejects(llm.complete({ kind: 'work', system: 's', user: 'HANG', maxTokens: 10 }), /did not answer/);
  assert.ok(Date.now() - started < 30000);
  assert.match(llm.status().lastError, /did not answer/);
});
