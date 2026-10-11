import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, findPath } from '../server/map.js';
import { AGENTS } from '../server/roster.js';
import { loadSkills, bestSkill, SKILLS_DIR, HR_SKILLS_DIR } from '../server/skills.js';
import { planFromPlaybooks } from '../server/mock.js';
import { extractJson } from '../server/llm.js';
import { world, run } from './helpers.js';

test('every desk, seat and spot is reachable from the town hall', () => {
  const m = buildMap();
  const start = { tx: 24, ty: 13 };
  const spots = Object.entries(m.spots).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((s, i) => [`${k}${i}`, s]));
  for (const [k, l] of Object.entries(m.desks)) l.forEach((d, i) => spots.push([`${k}:seat${i}`, d.seat], [`${k}:visit${i}`, d.visit]));
  for (const [name, s] of spots) assert.ok(findPath(m.walk, start, s), `unreachable: ${name}`);
});

test('roster: unique desks, every skill exists in the library', () => {
  const skills = loadSkills([{ dir: SKILLS_DIR, source: 'marketing' }, { dir: HR_SKILLS_DIR, source: 'hr' }]);
  assert.ok(Object.keys(skills).length >= 45, 'skills should be loaded');
  const seen = new Set();
  for (const a of AGENTS) {
    const key = `${a.room}:${a.slot}`; assert.ok(!seen.has(key), `duplicate desk ${key}`); seen.add(key);
    for (const s of a.skills) assert.ok(skills[s], `${a.id} references missing skill ${s}`);
  }
  const m = buildMap();
  for (const a of AGENTS) assert.ok(m.desks[a.room]?.[a.slot], `${a.id} has no desk`);
});

test('playbook planner picks sensible specialists', () => {
  const p = planFromPlaybooks('Launch our new project management app', 'Product Hunt launch with a press push');
  const agents = p.steps.map((s) => s.agent);
  assert.ok(agents.includes('imani') && agents.includes('theo'), agents.join());
  const seo = planFromPlaybooks('Grow organic traffic', 'We need SEO and a blog strategy');
  assert.ok(seo.steps.some((s) => s.agent === 'rafa'));
  for (const s of p.steps) s.deps.forEach((d) => assert.ok(d < p.steps.indexOf(s)));
  const fallback = planFromPlaybooks('Help', 'xyzzy');
  assert.ok(fallback.steps.length >= 3);
});

test('bestSkill matches the brief', () => {
  const skills = loadSkills();
  assert.equal(bestSkill(skills, ['seo-audit', 'copywriting', 'ads'], 'rewrite the homepage copy'), 'copywriting');
  assert.equal(bestSkill(skills, ['seo-audit', 'copywriting', 'ads'], 'google ads campaign'), 'ads');
});

test('extractJson tolerates fences and chatter', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here: {"a":[1,2]} thanks'), { a: [1, 2] });
  assert.equal(extractJson('no json'), null);
});

test('normalizePlan rejects junk and fixes dependencies', () => {
  const { company } = world();
  assert.equal(company.normalizePlan({ steps: [{ agent: 'nobody' }] }), null);
  const p = company.normalizePlan({ summary: 'x', steps: [{ agent: 'sol', skill: 'competitors', deps: [5, 'a'] }, { agent: 'theo', skill: 'copywriting', deps: [0, 0, 9] }] });
  assert.deepEqual(p.steps[0].deps, []);
  assert.deepEqual(p.steps[1].deps, [0]);
});

test('end to end (simulated): a task is planned, worked, reviewed, summarised', async () => {
  const w = world();
  const events = [];
  w.company.on('broadcast', (m) => events.push(m.type));
  const task = w.company.submitTask({ title: 'Launch our meal-kit startup', brief: 'Launch with PR and paid ads. Budget $20k.' });
  const finished = await run(w.sim, () => task.status === 'done' || task.status === 'failed', 900);
  assert.ok(finished, `task should finish, status=${task.status}`);
  assert.equal(task.status, 'done');
  assert.ok(task.subtasks.length >= 3);
  assert.ok(task.subtasks.every((s) => s.status === 'done'), JSON.stringify(task.subtasks.map((s) => s.status)));
  assert.ok(task.summaryId, 'has an executive summary');
  const d = w.company.deliverables.get(task.summaryId);
  assert.match(d.markdown, /Executive summary/);
  assert.ok(w.company.deliverables.size >= task.subtasks.length + 1);
  assert.ok(events.includes('comms') && events.includes('deliverable') && events.includes('task'));
  assert.ok(w.company.comms.some((c) => c.kind === 'review'), 'peer review happened');
  assert.ok(w.llm.totals.calls > 5);
  // regression: unresolved template values must never leak into chat or deliverables
  for (const c of w.company.comms) assert.ok(!/undefined|\[object/.test(c.text), `bad comms text: ${c.text}`);
  for (const d of w.company.deliverables.values()) assert.ok(!/undefined|\[object/.test(d.markdown), `bad deliverable ${d.id}`);
  // nobody is left stuck busy once the finale is over
  await run(w.sim, () => [...w.sim.agents.values()].every((a) => !a.busy), 120);
  assert.ok([...w.sim.agents.values()].every((a) => !a.busy));
});

test('direct assignment skips the planner', async () => {
  const w = world();
  const task = w.company.submitTask({ title: 'Rewrite our homepage copy', brief: 'B2B payroll software', assignee: 'theo' });
  await run(w.sim, () => task.status === 'done' || task.status === 'failed', 600);
  assert.equal(task.status, 'done');
  assert.equal(task.subtasks.length, 1);
  assert.equal(task.subtasks[0].agent, 'theo');
  assert.equal(task.subtasks[0].skill, 'copywriting');
});

test('state survives a save/load round trip; interrupted tasks are flagged', async () => {
  const w = world();
  const t = w.company.submitTask({ title: 'Quick pricing review', brief: 'SaaS tiers', assignee: 'indigo' });
  await run(w.sim, () => t.status === 'done', 600);
  w.company.save();
  const t2 = w.company.submitTask({ title: 'Never finishes', brief: '', assignee: 'sol' });
  t2.status = 'active'; w.company.save();
  const w2 = world();
  w2.company.dataDir = w.company.dataDir; w2.company.deliverablesDir = w.company.deliverablesDir;
  assert.ok(w2.company.load());
  assert.equal(w2.company.tasks.get(t.id).status, 'done');
  assert.equal(w2.company.tasks.get(t2.id).status, 'interrupted');
  assert.ok(w2.company.deliverables.size >= 2);
});

test('ambient life runs without wedging agents', async () => {
  const w = world({ life: true });
  await run(w.sim, () => false, 240);
  const moved = [...w.sim.agents.values()].filter((a) => Math.hypot(a.x - a.desk.seat.x, a.y - a.desk.seat.y) > 1 || a.status !== 'Settling in');
  assert.ok(moved.length >= 5, `only ${moved.length} agents did anything`);
  assert.ok(w.company.comms.some((c) => c.kind === 'banter'), 'some banter happened');
});

test('a task claims an agent that is mid-ambient-activity', async () => {
  const w = world({ life: true });
  await run(w.sim, () => false, 40);
  const task = w.company.submitTask({ title: 'Audit our SEO', brief: 'ecommerce store', assignee: 'rafa' });
  assert.ok(await run(w.sim, () => task.status === 'done', 600), 'finished despite ambient behavior');
});
