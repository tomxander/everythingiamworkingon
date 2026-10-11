// The tracker: agents ask for what they cannot find, God answers, the answers reach the work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, run } from './helpers.js';

const finish = (w, t, max = 3000) => run(w.sim, () => ['done', 'failed'].includes(t.status), max);
const submit = (w, extra = {}) => w.company.submitTask({ title: 'Get acme.test more leads: 40 enquiries a month', brief: 'B2B SaaS. Budget $5k.', ...extra });

test('simulated agents raise the requests their playbooks really need, without blocking the work', async () => {
  const w = world(); const events = [];
  w.company.on('broadcast', (m) => events.push(m));
  const t = submit(w); assert.ok(await finish(w, t)); assert.equal(t.status, 'done', t.error);
  const reqs = w.company.requestsPublic().filter((r) => r.taskId === t.id);
  assert.ok(reqs.length >= 2 && reqs.length <= 8, `requests ${reqs.length}`);
  assert.ok(reqs.every((r) => r.status === 'open' && r.what.length > 8 && r.tried), 'each says what and what was tried');
  assert.ok(reqs.some((r) => r.origin === 'intake'), 'the intake questions are tracked');
  assert.ok(reqs.some((r) => ['data', 'document'].includes(r.kind)), 'agents ask for data and documents');
  assert.equal(new Set(reqs.map((r) => r.what)).size, reqs.length, 'no duplicates');
  assert.ok(events.some((e) => e.type === 'request'));
  assert.ok(t.thread.some((m) => m.kind === 'question' && m.to === 'god'));
});

test('a brief that already supplies the data does not trigger the request', async () => {
  const w = world();
  const t = submit(w, { brief: 'B2B SaaS. Analytics export attached, Search Console export attached, funnel and conversion rate attached, CPA and ad account data attached.' });
  assert.ok(await finish(w, t));
  const kinds = w.company.requestsPublic().filter((r) => r.taskId === t.id && r.origin === 'agent').map((r) => r.what);
  assert.ok(!kinds.some((k) => /analytics|Search Console|Funnel numbers|Ad account/i.test(k)), kinds.join(' | '));
});

test('answers (text and attached files) reach later work; declining is recorded; empty answers are refused', () => {
  const w = world(); const t = { id: 'T9', title: 'x', subtasks: [] }; w.company.tasks.set('T9', t);
  const a = w.company.agent('dee');
  const r1 = w.company.raiseRequest(t, a, { kind: 'data', what: 'Last 90 days of analytics by source', why: 'baseline', tried: 'searched' }).req;
  const r2 = w.company.raiseRequest(t, a, { kind: 'question', what: 'Which competitors do you lose deals to?', why: 'x', tried: 'searched' }).req;
  assert.match(w.company.requestsText(t), /Still unanswered[\s\S]*analytics by source/);
  assert.throws(() => w.company.answerRequest(r1.id, { text: '  ' }), /Type an answer/);
  w.company.answerRequest(r1.id, { text: 'Organic 40%, paid 30%.', files: [{ name: 'ga.csv', text: 'source,sessions\nseo,1200' }] });
  w.company.answerRequest(r2.id, { decline: true });
  const txt = w.company.contextText(t);
  assert.match(txt, /Information from God[\s\S]*Organic 40%[\s\S]*seo,1200/); assert.match(txt, /God cannot provide this/);
  assert.equal(r1.status, 'answered'); assert.deepEqual(r1.answer.files, [{ name: 'ga.csv', size: 24 }]); assert.equal(r2.status, 'declined');
});

test('request_info tool: must say what was tried, de-duplicates, and respects the caps', async () => {
  const w = world(); const t = { id: 'T8', title: 'x', subtasks: [] }; w.company.tasks.set('T8', t); const a = w.company.agent('rafa');
  assert.match(await w.company.toolRequest(a, t, { kind: 'data', what: 'Search Console export for 90 days', why: 'x', tried: '' }), /search the wider internet/i);
  const ok = await w.company.toolRequest(a, t, { kind: 'data', what: 'Search Console export for 90 days', why: 'x', tried: 'Searched the web and the site; not public.' });
  assert.match(ok, /Logged as Q\d+[\s\S]*do not wait/);
  assert.match(await w.company.toolRequest(a, t, { kind: 'data', what: 'search console export, last 90 days', why: 'x', tried: 'Searched again for it.' }), /Already requested/);
  for (const what of ['Brand voice guide document', 'Best past customer list']) await w.company.toolRequest(a, t, { kind: 'document', what, why: 'x', tried: 'searched the web, nothing' });
  assert.match(await w.company.toolRequest(a, t, { kind: 'document', what: 'Something else entirely different', why: 'x', tried: 'searched the web, nothing' }), /already made 3 requests/);
});

test('applying answers updates the deliverables that asked, once, and the state persists', async () => {
  const w = world(); const t = submit(w); assert.ok(await finish(w, t));
  const reqs = w.company.requestsPublic().filter((r) => r.taskId === t.id && r.subId);
  const r = reqs[0]; w.company.answerRequest(r.id, { text: 'Baseline: 1,000 sessions a week, 2% convert.' });
  const res = await w.company.applyAnswers(t.id); assert.equal(res.applied, 1); assert.ok(res.updated >= 1);
  const d = w.company.deliverables.get(t.subtasks.find((s) => s.id === r.subId).outputId);
  assert.match(d.markdown, /Update after God's answers[\s\S]*1,000 sessions/); assert.ok(d.revised);
  await assert.rejects(w.company.applyAnswers(t.id), /Nothing new/);
  w.company.save(); const w2 = world(); w2.company.dataDir = w.company.dataDir; w2.company.load();
  assert.equal(w2.company.requestsPublic().find((x) => x.id === r.id).status, 'answered');
});
