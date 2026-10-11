// How the team talks: org structure, kickoff, shared channel, handoffs, lead-first review,
// alignment meetings with decisions, escalation and recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, TEAM_LEADS } from '../server/roster.js';
import { world, run } from './helpers.js';

const finish = (w, t, max = 3000) => run(w.sim, () => ['done', 'failed'].includes(t.status), max);

test('the org chart is coherent: every agent has a team lead, leads report to the CMO', () => {
  const byId = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
  for (const a of AGENTS) {
    if (a.id === 'vera') { assert.equal(a.reportsTo, null); continue; }
    assert.ok(byId[a.reportsTo], `${a.id} reports to a real person`);
    if (!a.lead) assert.ok(byId[a.reportsTo].lead, `${a.id} reports to a team lead`);
    else assert.equal(a.reportsTo, 'vera');
  }
  for (const [dept, leadId] of Object.entries(TEAM_LEADS)) assert.equal(byId[leadId].dept, dept);
});

test('kickoff: the owners are briefed together, leads speak first, and the channel records it', async () => {
  const w = world();
  const t = w.company.submitTask({ title: 'Get acme.test more leads: 40 enquiries a month', brief: 'B2B. Budget $5k.' });
  assert.ok(await finish(w, t)); assert.equal(t.status, 'done');
  const k = t.meetings.find((m) => m.type === 'kickoff'); assert.ok(k, 'a kickoff happened');
  const owners = [...new Set(t.subtasks.map((s) => s.agent))].filter((id) => id !== 'vera');
  assert.equal(k.turns[0].agent, 'vera', 'the CMO opens');
  assert.ok(owners.every((id) => k.turns.some((x) => x.agent === id)), 'every owner confirmed their part');
  const order = k.turns.map((x) => x.agent); const firstMember = order.findIndex((id) => id !== 'vera' && !w.company.agent(id).lead); const lastLead = order.map((id, i) => (w.company.agent(id).lead && id !== 'vera' ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
  if (firstMember !== -1 && lastLead !== -1) assert.ok(lastLead < firstMember, 'leads speak before their members');
  assert.ok(w.company.comms.some((c) => c.kind === 'kickoff' && c.taskId === t.id));
  const hero = k.turns.find((x) => x.agent === 'nadia' || x.agent === 'theo');
  assert.match(hero.text, /need|start|risk/i, 'replies say what is needed and what the risk is');
});

test('the task channel is read: later work shows the team input it considered', async () => {
  const w = world();
  const t = w.company.submitTask({ title: 'Get acme.test more leads', brief: '' });
  assert.ok(await finish(w, t));
  const text = w.company.threadText(t, 'theo'); assert.match(text, /\[kickoff\]/); assert.match(text, /\[handoff\]/);
  const theoSub = t.subtasks.find((s) => s.agent === 'theo');
  const md = w.company.deliverables.get(theoSub.outputId).markdown;
  assert.match(md, /## Team input considered/, 'the deliverable reflects what teammates said');
  assert.ok(!(t.thread || []).some((m) => m.kind === 'banter'), 'small talk never enters the work channel');
});

test('handoffs: finished work is passed to each downstream owner with what they must know', async () => {
  const w = world();
  const t = w.company.submitTask({ title: 'Get acme.test more leads', brief: '' });
  assert.ok(await finish(w, t));
  const edges = t.subtasks.flatMap((s) => s.deps.map((d) => [t.subtasks[d].agent, s.agent])).filter(([a, b]) => a !== b);
  assert.ok(edges.length >= 2, 'the plan has dependencies');
  for (const [from, to] of edges.slice(0, 3)) assert.ok(w.company.comms.some((c) => c.kind === 'handoff' && c.from === from && c.to === to), `handoff ${from} -> ${to}`);
  const down = t.subtasks.find((s) => s.deps.length && s.handoff); assert.ok(down.handoff.length > 20);
  assert.match(w.company.agent(down.agent).memory.map((m) => m.text).join(' '), /handed off/);
});

test('review goes to the team lead first, then a cross-functional expert, never the author', async () => {
  const w = world(); const c = w.company;
  assert.equal(c.pickReviewer(c.agent('theo'), { skill: 'copywriting' }).id, 'zuri', 'a member is reviewed by their lead');
  assert.equal(c.pickReviewer(c.agent('priya'), { skill: 'ai-seo' }).id, 'rafa');
  assert.equal(c.pickReviewer(c.agent('nadia'), { skill: 'cro' }).id, 'vera', 'a lead with no expert peer goes to the CMO');
  assert.equal(c.pickReviewer(c.agent('camila'), { skill: 'ads' }).id, 'oskar');
  assert.equal(c.pickReviewer(c.agent('rafa'), { skill: 'seo-audit' }).id, 'vera', 'never reviews their own work');
  assert.equal(c.pickReviewer(c.agent('vera'), { skill: 'marketing-plan' }).id, 'sol');
  const t = c.submitTask({ title: 'Rewrite the hero', brief: 'x', assignee: 'theo' });
  assert.ok(await finish(w, t)); assert.equal(t.subtasks[0].review.by, 'zuri');
});

test('alignment: a real conflict between workstreams is found, decided, recorded and applied', async () => {
  const w = world();
  const t = w.company.submitTask({ title: 'Get acme.test more leads', brief: '' });
  assert.ok(await finish(w, t));
  const have = t.subtasks.map((s) => `${s.agent}:${s.skill}`);
  assert.ok(have.includes('nadia:cro') && have.includes('theo:copywriting'), 'both conflicting workstreams are on the plan');
  assert.ok(t.decisions.length >= 1); const d = t.decisions[0]; assert.deepEqual(d.agents.sort(), ['nadia', 'theo']); assert.match(d.decision, /variant|control|test/i);
  const m = t.meetings.find((x) => x.type === 'alignment'); assert.ok(m && m.turns.length >= 4, 'question, two positions and a decision');
  assert.equal(m.turns.at(-1).agent, 'vera');
  for (const id of ['nadia', 'theo']) assert.match(w.company.deliverables.get(t.subtasks.find((s) => s.agent === id).outputId).markdown, /Decision after the alignment meeting/);
  assert.match(w.company.deliverables.get(t.summaryId).markdown, /Decisions made along the way/);
  assert.ok(w.company.kb.view().some((l) => l.source === 'decision' && l.scope === 'team'), 'the decision became a team lesson');
});

test('no conflict means no invented conflict', async () => {
  const w = world();
  const t = w.company.submitTask({ title: 'Rewrite the hero', brief: 'x', assignee: 'theo' });
  assert.ok(await finish(w, t)); assert.equal((t.decisions || []).length, 0);
  const t2 = w.company.submitTask({ title: 'Plan pricing for the team', brief: 'pricing tiers' });
  assert.ok(await finish(w, t2)); assert.equal((t2.decisions || []).length, 0, 'the pricing plan has no conflicting pair');
});

test('collab off: the team just works, no meetings, no handoffs, no decisions', async () => {
  const w = world({ collab: 'off' });
  const t = w.company.submitTask({ title: 'Get acme.test more leads', brief: '' });
  assert.ok(await finish(w, t)); assert.equal(t.status, 'done');
  assert.equal((t.meetings || []).filter((m) => m.type !== 'retro').length, 0);
  assert.ok(!w.company.comms.some((c) => c.kind === 'handoff' || c.kind === 'kickoff'));
});

test('escalation: a failure goes to the lead, is retried once, and recovers', async () => {
  const w = world(); const real = w.llm.complete.bind(w.llm); let failed = 0;
  w.llm.complete = async (o) => { if (o.kind === 'work' && o.ctx?.agent?.id === 'rafa' && failed++ === 0) throw new Error('model overloaded'); return real(o); };
  const t = w.company.submitTask({ title: 'Get acme.test more leads', brief: '' });
  assert.ok(await finish(w, t)); assert.equal(t.status, 'done');
  const rafa = t.subtasks.find((s) => s.agent === 'rafa'); assert.equal(rafa.retried, true); assert.equal(rafa.status, 'done');
  assert.ok(w.company.comms.some((c) => c.kind === 'question' && c.from === 'rafa' && /blocked/.test(c.text)), 'told the lead');
  assert.ok(w.company.comms.some((c) => c.kind === 'decision' && c.to === 'rafa' && /Retry/i.test(c.text)), 'the lead decided to retry');
});

test('escalation: a workstream that fails twice is cut and flagged, and the task still completes', async () => {
  const w = world(); const real = w.llm.complete.bind(w.llm);
  w.llm.complete = async (o) => { if (o.kind === 'work' && o.ctx?.agent?.id === 'oskar') throw new Error('permanent failure'); return real(o); };
  const t = w.company.submitTask({ title: 'Get acme.test more leads', brief: '' });
  assert.ok(await finish(w, t)); assert.equal(t.status, 'done');
  const s = t.subtasks.find((x) => x.agent === 'oskar'); assert.equal(s.status, 'failed');
  assert.ok(w.company.comms.some((c) => c.kind === 'decision' && /failed twice/.test(c.text)));
  assert.ok(w.company.kb.view().some((l) => l.source === 'failure'), 'a failure lesson was recorded');
});
