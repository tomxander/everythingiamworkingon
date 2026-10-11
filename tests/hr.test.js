// People & Talent: requisitions, onboarding, performance reviews, workforce reports, releases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, run } from './helpers.js';

const finish = (w, t, max = 3000) => run(w.sim, () => ['done', 'failed'].includes(t.status), max);
async function settle(w, p, max = 900) { let done = false, err = null, val; p.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; }); await run(w.sim, () => done, max); if (err) throw err; return val; }

test('Nia and Tomás exist, own HR playbooks from the HR library, and have desks in their own room', () => {
  const w = world(); const nia = w.company.agent('nia'), tomas = w.company.agent('tomas');
  assert.equal(nia.room, 'people'); assert.equal(tomas.reportsTo, 'nia'); assert.equal(nia.reportsTo, null);
  for (const a of [nia, tomas]) for (const k of a.skills) assert.equal(w.skills[k].source, 'hr', `${k} comes from the HR library`);
  assert.ok(w.map.desks.people.length >= 2);
});

test('a hire gets a job description and a 30/60/90 plan from Nia, and Nia welcomes them', async () => {
  const w = world();
  const h = await settle(w, w.company.hire(null, { role: 'SEO Associate', skills: ['seo-audit'], why: 'Rafa is swamped', capacity: true }));
  assert.match(h.jd, /^# SEO Associate/); assert.match(h.jd, /Reports to/);
  assert.equal(h.onboarding.length, 3); assert.ok(h.onboarding.every((p) => p.goals.length >= 2));
  assert.ok(h.memory.some((m) => /Onboarding plan from Nia/.test(m.text)));
  assert.ok(w.company.comms.some((c) => c.from === 'nia' && /Requisition for SEO Associate/.test(c.text)));
  assert.equal(w.company.publicAgent(h).jd, h.jd);
});

test('the hiring caps still stop a hire; HR cannot raise them', async () => {
  const w = world(); w.company.hiringCaps.total = 0;
  await assert.rejects(w.company.hire(null, { role: 'SEO Associate', skills: ['seo-audit'], why: 'x', capacity: true }), /limit/);
});

test('performance review: rating comes from counted facts, development areas become lessons', async () => {
  const w = world();
  const t1 = w.company.submitTask({ title: 'Get acme.test more leads', brief: 'B2B.' }); assert.ok(await finish(w, t1));
  const rev = await settle(w, w.company.performanceReview('rafa'));
  assert.equal(rev.agent, 'rafa'); assert.ok(rev.facts.delivered >= 1);
  const expected = rev.facts.reviewed < 3 ? 'Too early to rate' : rev.facts.firstPass >= 0.9 ? 'Exceeds expectations' : rev.facts.firstPass >= 0.7 ? 'Meets expectations' : 'Needs development';
  assert.equal(rev.rating, expected);
  assert.ok(w.company.hrPublic().reviews[0].id === rev.id);
  // synthetic facts exercise each band
  const f = (reviewed, firstPass) => ({ reviewed, firstPass });
  assert.equal(w.company.rate(f(2, 1)), 'Too early to rate'); assert.equal(w.company.rate(f(5, 0.95)), 'Exceeds expectations');
  assert.equal(w.company.rate(f(5, 0.75)), 'Meets expectations'); assert.equal(w.company.rate(f(5, 0.4)), 'Needs development');
});

test('workforce report is a deliverable with counted numbers and recommendations', async () => {
  const w = world();
  const t = w.company.submitTask({ title: 'Get acme.test more leads', brief: 'B2B.' }); assert.ok(await finish(w, t));
  const rep = await settle(w, w.company.workforceReport({ reason: 'test' }));
  const d = w.company.deliverables.get(rep.deliverable);
  assert.equal(d.kind, 'hr'); assert.equal(d.agent, 'nia'); assert.match(d.markdown, /# Workforce report/); assert.match(d.markdown, /\| Rafael/); assert.match(d.markdown, /Recommendations/);
  assert.ok(rep.recommendations.length >= 1);
});

test('release: HR proposes, only God decides, and the founding team is never proposed', async () => {
  const w = world();
  const h = await settle(w, w.company.hire(null, { role: 'SEO Associate', skills: ['seo-audit'], why: 'x', capacity: true }));
  assert.equal(w.company.proposeRelease(w.company.agent('rafa'), 'x'), null, 'founders are not on the list');
  const r = w.company.proposeRelease(h, 'Rated Needs development twice');
  assert.equal(r.status, 'pending'); assert.ok(w.company.agent(h.id), 'still employed until God decides');
  assert.equal(w.company.proposeRelease(h, 'again'), null, 'one pending proposal per person');
  await w.company.decideRelease(r.id, false); assert.equal(r.status, 'declined'); assert.ok(w.company.agent(h.id));
  const r2 = w.company.proposeRelease(h, 'second look');
  await w.company.decideRelease(r2.id, true); assert.equal(r2.status, 'approved'); assert.equal(w.company.agent(h.id), undefined);
});

test('two consecutive Needs-development reviews on a hire raise a release proposal', () => {
  const w = world(); const h = { id: 'hX', hired: true, name: 'Hal', role: 'R' };
  const st = w.company.hrState(); st.reviews.unshift({ id: 'R0', agent: 'hX', rating: 'Needs development', facts: { reviewed: 4 } });
  w.company.releaseCheck(h, { id: 'R1', rating: 'Needs development', facts: { reviewed: 6, firstPass: 0.5 } });
  assert.equal(st.releases.length, 1); assert.equal(st.releases[0].status, 'pending');
});

test('Tomás notes skills-library changes; planner gets the workforce snapshot; state persists', () => {
  const w = world();
  w.company.skillsChanged({ id: 'hr' }, { added: ['hr-new-thing'], changed: ['hr-onboarding'], removed: [] });
  assert.ok(w.company.hrState().skillNotes[0].text.includes('hr-new-thing'));
  assert.ok(w.company.comms.some((c) => c.from === 'tomas'));
  assert.match(w.company.hrSnapshotText(), /Workforce: \d+\/24 desks/);
  w.company.hrState().reports.push({ id: 'W9' }); w.company.save();
  const w2 = world(); w2.company.dataDir = w.company.dataDir; w2.company.load();
  assert.equal(w2.company.hrState().reports[0].id, 'W9');
});

test('a task assigned to Nia runs on an HR playbook and finishes', async () => {
  const w = world();
  const t = w.company.submitTask({ title: 'Plan 4EVR headcount for the next quarter', brief: 'Which hires are justified?', assignee: 'nia' });
  assert.ok(await finish(w, t, 4000)); assert.equal(t.status, 'done', t.error);
  assert.ok(t.subtasks.every((s) => s.agent === 'nia'));
  assert.ok(w.skills[t.subtasks[0].skill].source === 'hr');
});
