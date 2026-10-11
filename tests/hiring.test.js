// Growing the team: when hiring is justified, the guardrails, approval mode, onboarding, firing, persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, run } from './helpers.js';

const finish = (w, t, max = 3000) => run(w.sim, () => ['done', 'failed'].includes(t.status), max);
async function settle(w, p, max = 600) { let done = false, err = null, val; p.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; }); await run(w.sim, () => done, max); if (err) throw err; return val; }

test('a brief in a domain nobody knows gets a specialist hired before kickoff, and the team builds on their brief', async () => {
  const w = world(); const events = [];
  w.company.on('broadcast', (m) => events.push(m));
  const t = w.company.submitTask({ title: 'Get Acme Drives more leads', brief: 'We supply ADAS and infotainment software to automotive OEMs and tier-1 suppliers.' });
  assert.ok(await finish(w, t)); assert.equal(t.status, 'done', t.error);
  assert.equal(t.hires.length, 1);
  const h = w.company.agent(t.hires[0]);
  assert.equal(h.hired, true); assert.equal(h.room, 'annex'); assert.equal(h.role, 'Automotive Industry Strategist'); assert.deepEqual(h.domains, ['automotive']); assert.equal(h.reportsTo, 'vera');
  assert.ok(h.skills.every((s) => w.skills[s]), 'only real library skills');
  assert.equal(t.subtasks[0].agent, h.id, 'the domain brief goes first');
  const feeds = t.subtasks.filter((s) => ['copywriting', 'ads', 'cro'].includes(s.skill)); assert.ok(feeds.length && feeds.every((s) => s.deps.includes(0)), 'writers, planners and CRO build on the domain brief');
  assert.ok(events.some((e) => e.type === 'agent_added' && e.agent.id === h.id && e.agent.hired));
  assert.ok(w.company.comms.some((c) => c.kind === 'hire' && c.from === 'vera' && /Automotive Industry Strategist/.test(c.text)));
  assert.ok(t.meetings.find((m) => m.type === 'kickoff').participants.includes(h.id), 'the new hire is in the kickoff');
  assert.ok(w.company.deliverables.get(t.subtasks[0].outputId), 'the hire delivered');
  assert.ok(h.desk.seat.ty >= 31, 'and has a desk in the Annex');
  assert.match(w.company.deliverables.get(t.summaryId).markdown, new RegExp(h.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the summary credits the new hire\'s work');
});

test('no domain gap, no hire', async () => {
  const w = world();
  const t = w.company.submitTask({ title: 'Get acme.test more leads', brief: 'A plain B2B service business.' });
  assert.ok(await finish(w, t)); assert.equal((t.hires || []).length, 0);
});

test('hiring is refused when an existing teammate already covers the skills and has capacity', async () => {
  const w = world();
  await assert.rejects(w.company.hire(null, { role: 'Junior SEO Specialist', skills: ['seo-audit', 'site-architecture'], why: 'more SEO' }), /Rafael.*already covers/s);
  const ok = await settle(w, w.company.hire(null, { role: 'SEO Associate', skills: ['seo-audit'], why: 'Rafa is swamped', capacity: true }));
  assert.equal(ok.hired, true);
  await assert.rejects(w.company.hire(null, { role: 'Nobody', skills: [], why: 'x' }), /at least one skill/);
  await assert.rejects(w.company.hire(null, { role: 'x', skills: ['seo-audit'], why: 'x' }), /clear job title/);
  await assert.rejects(w.company.hire(null, { role: 'Wizard', skills: ['not-a-skill'], why: 'x' }), /at least one skill/);
});

test('guardrails: per-task cap, headcount cap, total cap, full annex, and hiring switched off', async () => {
  const w = world(); const c = w.company;
  await assert.rejects(c.hire({ id: 'T9', hires: ['a', 'b', 'c'] }, { role: 'Extra Hire', skills: ['ads'], why: 'x', capacity: true }), /already brought in 3/);
  const saved = { ...c.hiringCaps };
  c.hiringCaps.headcount = c.sim.agents.size; await assert.rejects(c.hire(null, { role: 'Extra Hire', skills: ['ads'], why: 'x', capacity: true }), /Headcount is at the cap/); c.hiringCaps = { ...saved };
  c.hiringCaps.total = 0; await assert.rejects(c.hire(null, { role: 'Extra Hire', skills: ['ads'], why: 'x', capacity: true }), /hiring limit/); c.hiringCaps = { ...saved, total: 99, headcount: 99 };
  for (let i = 0; i < 16; i++) c.sim.addAgent({ id: `f${i}`, short: `F${i}`, name: `F ${i}`, role: 'x', dept: 'growth', room: 'annex', slot: i, skills: [], quirks: [], persona: '', look: {}, color: '#fff' });
  await assert.rejects(c.hire(null, { role: 'Extra Hire', skills: ['ads'], why: 'x', capacity: true }), /no free desks/);
  c.hiringMode = 'off'; await assert.rejects(c.hire(null, { role: 'Extra Hire', skills: ['ads'], why: 'x', capacity: true }), /switched off/);
});

test('approval mode: the hire waits for God, who can approve or decline', async () => {
  const w = world({ hiring: 'ask' }); const c = w.company; const events = [];
  c.on('broadcast', (m) => events.push(m.type));
  const p1 = c.godHire({ role: 'Brand Strategist', skills: ['marketing-plan'], why: 'positioning work' }); p1.catch(() => {});
  await run(w.sim, () => c.pendingHires().length === 1, 60);
  const req = c.pendingHires()[0]; assert.equal(req.role, 'Brand Strategist'); assert.ok(events.includes('hire_request'));
  assert.equal(c.decideHire(req.id, false), true);
  await assert.rejects(settle(w, p1), /declined/); assert.ok(![...w.sim.agents.values()].some((a) => a.role === 'Brand Strategist'));
  const p2 = c.godHire({ role: 'Brand Strategist', skills: ['marketing-plan'], why: 'positioning work' });
  await run(w.sim, () => c.pendingHires().length === 1, 60); c.decideHire(c.pendingHires()[0].id, true);
  const agent = await settle(w, p2); assert.equal(agent.role, 'Brand Strategist'); assert.equal(c.pendingHires().length, 0); assert.ok(events.includes('hire_resolved'));
});

test('onboarding gives the new hire a welcome, memory, a unique name and a place in the org', async () => {
  const w = world(); const c = w.company;
  const a = await settle(w, c.godHire({ role: 'Marine Industry Strategist', skills: ['customer-research', 'competitors'], why: 'new marine client', domain: 'marine' }));
  assert.ok(a.memory.some((m) => /Joined 4EVR/.test(m.text))); assert.ok(a.mood > 80);
  assert.equal(a.reportsTo, 'vera'); assert.ok(!a.lead);
  const names = [...c.sim.agents.values()].map((x) => x.short.toLowerCase()); assert.equal(new Set(names).size, names.length, 'first names stay unique');
  const b = await settle(w, c.godHire({ role: 'Events Producer', skills: ['events'], why: 'conference season', domain: 'events' }));
  assert.equal(b.reportsTo, 'harper', 'an events hire joins revenue & reach under its lead'); assert.notEqual(a.desk.seat.tx, b.desk.seat.tx);
});

test('letting someone go: only hires, never mid-work, and what they learned stays', async () => {
  const w = world(); const c = w.company; const events = [];
  c.on('broadcast', (m) => events.push(m.type));
  const a = await settle(w, c.godHire({ role: 'Video Producer', skills: ['video'], why: 'video series', domain: 'video' }));
  await assert.rejects(c.fire('theo'), /Only people who were hired/);
  const l = c.kb.add({ scope: 'agent', agent: a.id, skill: 'video', dept: a.dept, text: 'Open every short video with the payoff in the first second.' });
  const weak = c.kb.add({ scope: 'agent', agent: a.id, skill: 'video', dept: a.dept, text: 'Add a long logo animation to the start of every clip.' }); weak.uses = 5; weak.wins = 0; weak.losses = 5;
  a.busy = true; await assert.rejects(c.fire(a.id), /working right now/); a.busy = false;
  await c.fire(a.id);
  assert.ok(!c.sim.agents.has(a.id) && !c.hires.has(a.id)); assert.ok(events.includes('agent_removed'));
  assert.equal(l.scope, 'team', 'a good lesson goes to the team'); assert.equal(weak.retired, true, 'a weak one is retired');
});

test('hires survive a restart, with their desk and their lessons', async () => {
  const w = world(); const a = await settle(w, w.company.godHire({ role: 'Localization Lead', skills: ['copywriting', 'copy-editing'], why: 'EU launch', domain: 'localization' }));
  a.stats.deliverables = 3; w.company.kb.add({ scope: 'agent', agent: a.id, text: 'Adapt proof points for each market rather than translating them.' }); w.company.save();
  const w2 = world(); w2.company.dataDir = w.company.dataDir; w2.company.kb.dir = w.company.dataDir; assert.ok(w2.company.load());
  const b = w2.company.agent(a.id); assert.ok(b, 'the hire is back'); assert.equal(b.role, 'Localization Lead'); assert.equal(b.desk.seat.tx, a.desk.seat.tx); assert.equal(b.stats.deliverables, 3);
  assert.ok(w2.company.kb.view().some((l) => l.agent === a.id));
  assert.equal(w2.company.hires.size, 1);
});

test('a specialist hired once is reused on the next matching brief, not hired again', async () => {
  const w = world(); const c = w.company;
  const t1 = c.submitTask({ title: 'Get Acme Drives more leads', brief: 'ADAS software for automotive OEMs and tier-1 suppliers.' });
  assert.ok(await finish(w, t1)); const bruno = c.agent(t1.hires[0]); assert.ok(bruno);
  const before = [...c.sim.agents.values()].length;
  const t2 = c.submitTask({ title: 'Plan SEO for Acme Drives', brief: 'The same automotive OEM audience; we need organic search.' });
  assert.ok(await finish(w, t2)); assert.equal(t2.status, 'done', t2.error);
  assert.equal(c.sim.agents.size, before, 'nobody new was hired'); assert.equal((t2.hires || []).length, 0);
  assert.equal(t2.subtasks[0].agent, bruno.id, 'the existing specialist briefs the team first');
  assert.ok(c.comms.some((m) => m.kind === 'hire' && m.taskId === t2.id && /already knows the automotive domain/.test(m.text)));
  assert.ok(bruno.stats.deliverables >= 2, 'and their experience accumulates');
});
