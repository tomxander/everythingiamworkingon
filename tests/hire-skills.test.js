// Hiring builds specialists from the skills library, after checking the upstream repo for newer playbooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillSync } from '../server/skillsync.js';
import { fakeGithub } from './gh.js';
import { world, run } from './helpers.js';

process.env.ALLOW_PRIVATE_FETCH = '1';
const gh = await fakeGithub();
test.after(() => gh.close());
const mk = (mode = 'auto', base = () => gh.base) => (skills, tmp) => new SkillSync({ skills, baseDir: new URL('../vendor/marketingskills/skills', import.meta.url).pathname, dataDir: `${tmp}/data`, repo: 'o/r', mode, apiBase: base(), archiveBase: base(), vendoredCommit: 'b'.repeat(40), trustBases: true });
async function settle(w, p, max = 800) { let done = false, err = null, val; p.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; }); await run(w.sim, () => done, max); if (err) throw err; return val; }
const finish = (w, t, max = 3000) => run(w.sim, () => ['done', 'failed'].includes(t.status), max);

test('before a hire, the upstream repo is checked; a brand-new playbook there becomes a specialist built from it', async () => {
  const w = world({ syncFor: mk() }); const c = w.company; gh.hits.length = 0; const events = [];
  c.on('broadcast', (m) => events.push(m.type));
  assert.ok(!w.skills['marine-logistics'], 'the vendored library has no such playbook'); assert.deepEqual(c.skillGaps(), [], 'and the team owns every skill it does have');
  const a = await settle(w, c.godHire({ role: '', skills: [], need: 'marketing for shipping companies, ports and marine logistics', why: 'a shipping client' }));
  assert.ok(gh.hits.some((h) => h.startsWith('/repos/o/r/commits/')) && gh.hits.some((h) => h.includes('/tar.gz/')), 'GitHub was checked and the archive fetched');
  assert.ok(w.skills['marine-logistics'], 'the new skill is now in the library'); assert.match(w.skills['seo-audit'].body, /UPSTREAM-UPDATED/, 'changed skills were updated too');
  assert.deepEqual(a.skills, ['marine-logistics']); assert.equal(a.role, 'Marine Logistics Marketing Specialist');
  assert.match(a.persona, /Built from the library's Marine Logistics Marketing playbook/);
  assert.deepEqual(a.skillSource, { library: 'marketing', repo: 'o/r', commit: 'aaaaaaa', builtFrom: ['marine-logistics'] }, 'it records which upstream version it was built from');
  assert.ok(events.includes('skills_updated') && events.includes('agent_added')); assert.deepEqual(c.skillGaps(), [], 'the new skill is now owned');
  assert.ok(c.log.some((l) => /Skills library updated: 1 new/.test(l.text) || /Skills library updated/.test(l.text)));
  // and the specialist really works from that playbook
  const t = c.submitTask({ title: 'Plan the launch for a ship agency', brief: 'x', assignee: a.id }); assert.ok(await finish(w, t));
  const md = c.deliverables.get(t.subtasks[0].outputId).markdown; assert.equal(t.subtasks[0].skill, 'marine-logistics'); assert.match(md, /Know the buyer/, 'the deliverable follows the new skill\'s own structure');
});

test('a need that no playbook in the library matches is refused, not invented', async () => {
  const w = world({ syncFor: mk() }); const c = w.company;
  await assert.rejects(c.godHire({ role: 'Basket Weaver', skills: [], need: 'underwater basket weaving instruction', why: 'x' }), /No playbook in the skills library matches this need/);
  assert.equal([...c.sim.agents.values()].filter((x) => x.hired).length, 0);
});

test('planning notices a capability gap in the library and hires a specialist built from that playbook', async () => {
  const w = world({ syncFor: mk() }); const c = w.company;
  const t = c.submitTask({ title: 'Win more charter business', brief: 'We are a shipping company with vessels and ports across Asia. Marketing for marine logistics companies is what we need.' });
  assert.ok(await finish(w, t)); assert.equal(t.status, 'done', t.error);
  const hire = c.agent(t.hires[0]); assert.ok(hire, 'someone was hired'); assert.deepEqual(hire.skills, ['marine-logistics']); assert.equal(hire.skillSource.commit, 'aaaaaaa');
  assert.equal(t.subtasks[0].agent, hire.id); assert.equal(t.subtasks[0].skill, 'marine-logistics');
  assert.match(c.deliverables.get(t.subtasks[0].outputId).markdown, /Know the buyer|Proof that works/);
  assert.ok(t.meetings.find((m) => m.type === 'kickoff').participants.includes(hire.id));
});

test('no gap, no hire: a new playbook upstream that the brief does not need hires nobody', async () => {
  const w = world({ syncFor: mk() }); const c = w.company;
  const t = c.submitTask({ title: 'Get acme.test more leads', brief: 'A plain B2B service business.' }); assert.ok(await finish(w, t));
  assert.equal((t.hires || []).length, 0); assert.ok(w.skills['marine-logistics'], 'the library was still updated'); assert.deepEqual(c.skillGaps(), ['marine-logistics'], 'and the gap is known');
});

test('an unreachable GitHub never blocks hiring: existing library skills are used and the failure is recorded', async () => {
  const dead = 'http://127.0.0.1:1'; const w = world({ syncFor: mk('auto', () => dead) }); const c = w.company;
  const a = await settle(w, c.godHire({ role: 'Video Producer', skills: ['video'], why: 'video series', domain: 'video' }));
  assert.equal(a.role, 'Video Producer'); assert.ok(w.sync.status().lastError); assert.ok(c.log.some((l) => /Skills update check failed/.test(l.text)));
});

test('ask mode: new playbooks wait for approval, so a hire cannot use them until you approve', async () => {
  const w = world({ syncFor: mk('ask') }); const c = w.company; const events = [];
  c.on('broadcast', (m) => events.push(m.type));
  await assert.rejects(c.godHire({ role: '', skills: [], need: 'marketing for shipping and marine logistics', why: 'x' }), /No playbook in the skills library/);
  assert.ok(events.includes('skills_pending')); assert.deepEqual(w.sync.status().pending.added, ['marine-logistics']); assert.ok(!w.skills['marine-logistics']);
  w.sync.approve(); assert.ok(w.skills['marine-logistics']);
  const a = await settle(w, c.godHire({ role: '', skills: [], need: 'marketing for shipping and marine logistics', why: 'x' })); assert.deepEqual(a.skills, ['marine-logistics']);
});

test('mode off: no network is touched', async () => {
  const w = world({ syncFor: mk('off') }); gh.hits.length = 0;
  await settle(w, w.company.godHire({ role: 'Video Producer', skills: ['video'], why: 'video series', domain: 'video' }));
  assert.equal(gh.hits.length, 0);
});

test('agents can describe a need mid-task through request_hire and get a specialist from the right playbook', async () => {
  const w = world({ syncFor: mk() }); const c = w.company;
  const t = c.submitTask({ title: 'Get acme.test more leads', brief: '' });
  await run(w.sim, () => t.status === 'active' && t.subtasks.some((s) => s.status === 'working'), 600);
  const rafa = c.agent('rafa');
  const msg = await settle(w, c.toolHire(rafa, t, { role: '', need: 'marketing for shipping companies and marine logistics', why: 'a marine sub-brand came up', assignment: 'Advise on how port agents choose suppliers.' }));
  assert.match(msg, /^Hired /); const added = t.subtasks.at(-1); assert.equal(added.skill, 'marine-logistics'); assert.equal(added.addedBy, 'rafa');
  assert.ok(await finish(w, t)); assert.equal(added.status, 'done');
});

test('the updated library and the specialists built from it survive a restart', async () => {
  const w = world({ syncFor: mk() }); const c = w.company; const a = await settle(w, c.godHire({ role: '', skills: [], need: 'marketing for shipping and marine logistics', why: 'x' })); c.save();
  const w2 = world({ syncFor: (skills) => { const s = new SkillSync({ skills, baseDir: new URL('../vendor/marketingskills/skills', import.meta.url).pathname, dataDir: `${w.tmp}/data`, repo: 'o/r', apiBase: gh.base, archiveBase: gh.base, trustBases: true }); Object.assign(skills, { ...skills }); return s; } });
  const { loadSkills } = await import('../server/skills.js'); Object.assign(w2.skills, loadSkills(w2.sync.dirs));
  assert.ok(w2.skills['marine-logistics'], 'the overlay is loaded on top of the vendored copy at startup');
  w2.company.dataDir = c.dataDir; w2.company.kb.dir = c.dataDir; assert.ok(w2.company.load());
  const b = w2.company.agent(a.id); assert.ok(b); assert.deepEqual(b.skills, ['marine-logistics']); assert.equal(b.skillSource.commit, 'aaaaaaa');
});
