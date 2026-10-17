// Growing the team. Vera, the team leads, and any agent mid-task can bring in a specialist when the
// work needs expertise or capacity nobody has. Guardrails: a headcount cap, a per-task cap, a duplicate
// check, an optional approval step for God, and a visible log. New hires get a desk in the Annex.
import { COMPANY, DEPT_META, TEAM_LEADS } from './roster.js';
import { bestSkill, rankSkills } from './skills.js';
import { extractJson } from './llm.js';
import { HIRE_ROLES, hireRulesFor, randomLook, pickName } from './mock.js';

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const uniq = (a) => [...new Set(a)];
const ANNEX_SLOTS = 16;

export const hiring = {
  publicAgent(a) {
    return { id: a.id, short: a.short, name: a.name, role: a.role, dept: a.dept, room: a.room, color: a.color, emoji: a.emoji, skills: a.skills, persona: a.persona, quirks: a.quirks, look: a.look, lead: !!a.lead, reportsTo: a.reportsTo || null, hired: !!a.hired, domains: a.domains || [], joined: a.joined || null, why: a.why || null, jd: a.jd || null, onboarding: a.onboarding || null };
  },

  hiringStatus() {
    const hired = [...this.sim.agents.values()].filter((a) => a.hired);
    return { mode: this.hiringMode, headcount: this.sim.agents.size, maxHeadcount: this.hiringCaps.headcount, hired: hired.length, maxHires: this.hiringCaps.total, freeDesks: ANNEX_SLOTS - [...this.sim.agents.values()].filter((a) => a.room === 'annex').length, pending: this.pendingHires() };
  },

  existingDomains() { return uniq([...this.sim.agents.values()].flatMap((a) => a.domains || [])); },

  load_of(id) {
    let n = 0;
    for (const t of this.tasks.values()) if (['planning', 'active', 'review', 'researching'].includes(t.status)) for (const s of t.subtasks) if (s.agent === id && ['waiting', 'ready', 'working'].includes(s.status)) n++;
    return n;
  },

  /** Why this person is needed: returns null when a hire is justified, otherwise a reason it is not. */
  hireObjection(spec, skills) {
    if (skills.some((k) => this.skillGaps(this.skills[k]?.source).includes(k))) return null; // the library has a playbook nobody on the team owns: a genuine capability gap
    const covering = [...this.sim.agents.values()].filter((x) => skills.every((k) => x.skills.includes(k)));
    if (spec.domain && !this.existingDomains().includes(String(spec.domain).toLowerCase())) return null; // new domain knowledge is a legitimate reason
    if (spec.capacity) return null;
    if (!covering.length) return null;
    if (covering.every((x) => this.load_of(x.id) >= 3)) return null; // everyone who can do it is swamped
    const c = covering[0];
    return `${c.name} (${c.role}) already covers ${skills.join(', ')} and has capacity. Ask them directly or assign the work to them.`;
  },

  async hire(task, spec, requesterId = 'vera') {
    if (this.hiringMode === 'off') throw new Error('Hiring is switched off.');
    // Before anyone is hired, look for newer playbooks upstream: a specialist is built from the newest library.
    await this.refreshSkills('hire');
    let skills = uniq((spec.skills || []).map(String).filter((s) => this.skills[s])).slice(0, 6);
    if (!skills.length) { // the need was described, not named: find the playbook(s) in the library that fit it
      const need = `${spec.role || ''} ${spec.need || ''} ${spec.why || ''} ${typeof spec.assignment === 'string' ? spec.assignment : ''}`;
      const { source, ranked } = this.rankLibraries(need);
      const gapSet = new Set(this.skillGaps(source));
      const gaps = ranked.filter((r) => gapSet.has(r.name)); // if the library has a playbook the team lacks, the specialist is built from exactly that
      const pool = gaps.length ? gaps : ranked;
      skills = pool.length ? pool.filter((r) => r.score >= pool[0].score * 0.6).slice(0, 3).map((r) => r.name) : [];
    }
    if (!skills.length) throw new Error('No playbook in the skills library matches this need, so there is nothing to build a specialist from. The library is checked against its upstream repository before every hire.');
    const gap = skills.filter((k) => this.skillGaps(this.skills[k]?.source).includes(k));
    const source = this.skills[skills[0]]?.source || 'marketing'; // marketing hires come from the marketing library, HR-domain hires from the HR library
    const role = clip(String(spec.role || (gap.length ? `${this.skills[gap[0]].title} Specialist` : '')).replace(/[<>`]/g, '').trim(), 60);
    if (role.length < 4) throw new Error('A hire needs a clear job title.');
    const hiredCount = [...this.sim.agents.values()].filter((a) => a.hired).length;
    if (this.sim.agents.size >= this.hiringCaps.headcount) throw new Error(`Headcount is at the cap of ${this.hiringCaps.headcount}.`);
    if (hiredCount >= this.hiringCaps.total) throw new Error(`The hiring limit of ${this.hiringCaps.total} people has been reached.`);
    if (task && (task.hires?.length || 0) >= this.hiringCaps.perTask) throw new Error(`This task already brought in ${this.hiringCaps.perTask} people.`);
    const taken = new Set([...this.sim.agents.values()].filter((a) => a.room === 'annex').map((a) => a.slot));
    const slot = [...Array(ANNEX_SLOTS).keys()].find((i) => !taken.has(i));
    if (slot === undefined) throw new Error('There are no free desks left in the Annex.');
    const objection = this.hireObjection(spec, skills); if (objection) throw new Error(objection);
    if (this.hiringMode === 'ask') await this.awaitHireApproval(task, { ...spec, role, skills }, requesterId);

    const dept = spec.dept && DEPT_META[spec.dept] ? spec.dept : source === 'hr' ? 'people' : this.deptForSkills(skills);
    const lead = this.agent(TEAM_LEADS[dept]) || this.agent('vera');
    const req = await this.hrRequisition(task, { role, skills, why: spec.why, dept, lead, gap, domain: spec.domain });
    const profile = await this.makeProfile(task, { role, skills, why: spec.why, domain: spec.domain, dept, lead, gap });
    const seq = ++this.seq.hire; const first = profile.first;
    const def = {
      id: `h${seq}-${first.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10) || 'new'}`, short: first, name: `${first} ${profile.last}`, role, dept, room: 'annex', slot, color: DEPT_META[dept].color, emoji: 'badge',
      skills, persona: profile.persona, quirks: profile.quirks, look: randomLook(`${role}${seq}`, DEPT_META[dept].color), lead: false, reportsTo: lead.id, hired: true,
      domains: spec.domain ? [String(spec.domain).toLowerCase().slice(0, 24)] : [], skillSource: this.skillSourceFor(source, skills), jd: req.jd, onboarding: req.plan, hiredFor: task?.id || null, why: clip(String(spec.why || ''), 240), joined: Date.now(), by: requesterId,
    };
    const agent = this.sim.addAgent(def, { spawn: this.sim.map.spots.annexdoor });
    this.hires.set(def.id, def);
    if (task) (task.hires ||= []).push(def.id);
    this.emit('broadcast', { type: 'agent_added', agent: this.publicAgent(agent), hiring: this.hiringStatus() });
    this.life?.loop(agent);
    this.addLog(`${this.agent(requesterId)?.name || 'God'} hired ${def.name} as ${role}`, { type: 'system', agent: def.id, taskId: task?.id });
    this.talk(task, { from: requesterId, to: 'all', kind: 'hire', text: `I'm bringing in ${def.name} as ${role}, reporting to ${lead.short}. Why: ${clip(String(spec.why || 'the work needs it'), 160)}` });
    this.toast(`Hired ${def.name}, ${role}`, 'good');
    await this.onboard(agent, task, lead);
    return agent;
  },

  /** Library skills that no current teammate owns. These are the capabilities the team cannot deliver today. */
  skillGaps(source = 'marketing') {
    const owned = new Set([...this.sim.agents.values()].flatMap((a) => a.skills));
    return Object.keys(this.skills).filter((k) => !owned.has(k) && (this.skills[k].source || 'marketing') === source);
  },

  /** Rank each library on its own (word rarity is judged within a library) and pick the one that fits the need best. */
  rankLibraries(need) {
    const sub = (src) => Object.fromEntries(Object.entries(this.skills).filter(([, s]) => (s.source || 'marketing') === src));
    const min = { marketing: 8, hr: 14 }; // the HR library is much larger and noisier, so a hire from it needs a stronger match
    const best = { source: 'marketing', ranked: [], fit: 0 };
    for (const src of ['marketing', 'hr']) {
      const lib = sub(src); if (!Object.keys(lib).length) continue;
      const ranked = rankSkills(lib, need, 6, lib).filter((r) => r.score >= min[src]);
      const fit = ranked.length ? ranked[0].score / min[src] : 0;
      if (fit > best.fit) { best.source = src; best.ranked = ranked; best.fit = fit; }
    }
    return best;
  },

  skillSyncFor(source) { return (this.skillSyncs || []).find((s) => s.id === source) || null; },
  skillSourceFor(source, skills) { const ss = this.skillSyncFor(source); return { library: source, repo: ss?.repo || null, commit: ss?.commit ? ss.commit.slice(0, 7) : null, builtFrom: skills }; },

  /** Simulated mode: a brief that really matches an unowned playbook gets a specialist built from it. */
  skillGapSpecs(text) {
    const out = [];
    for (const [src, min, dept] of [['marketing', 8, 'strategy'], ['hr', 14, 'people']]) {
      const universe = Object.fromEntries(Object.entries(this.skills).filter(([, s]) => (s.source || 'marketing') === src));
      const gaps = Object.fromEntries(this.skillGaps(src).map((k) => [k, this.skills[k]]));
      for (const r of rankSkills(gaps, text, 2, universe).filter((x) => x.score >= min)) {
        const s = this.skills[r.name];
        out.push({ role: clip(`${s.title} Specialist`, 60), skills: [r.name], gap: true, why: `The "${r.name}" playbook is in the skills library but nobody on the team owns it, and this brief needs it.`, assignment: [r.name, `Apply the ${s.title} playbook to this brief and give the team the guidance they need before they write or plan.`], dept });
      }
      if (out.length) break; // the marketing library wins when it fits; HR playbooks are only for genuinely HR-domain briefs
    }
    return out.slice(0, 2);
  },

  /** Check the upstream skills repository (throttled) and update the library from it. */
  async refreshSkills(reason) {
    const syncs = (this.skillSyncs || []).filter((s) => s.mode !== 'off'); if (!syncs.length) return null;
    const out = await Promise.all(syncs.map((ss) => ss.check({ reason }).catch((e) => { this.addLog(`Skills update check failed (${ss.id}): ${e.message}`, { type: 'system' }); return null; })));
    return out;
  },

  skillsStatus() { return (this.skillSyncs || []).map((s) => s.status()); },

  attachSkillSync(ss) {
    if (!ss) return; (this.skillSyncs ||= []).push(ss);
    ss.on('updated', (e) => {
      const n = (e.added?.length || 0) + (e.changed?.length || 0);
      this.addLog(`${ss.id === 'hr' ? 'HR skills' : 'Skills'} library ${e.result}: ${e.added?.length ? `${e.added.length} new (${e.added.slice(0, 4).join(', ')}) ` : ''}${e.changed?.length ? `${e.changed.length} updated ` : ''}at ${e.commit}`, { type: 'system' });
      if (n || e.result === 'rolled-back') this.toast(e.result === 'rolled-back' ? 'Skills library rolled back' : `Skills library updated: ${e.added?.length || 0} new, ${e.changed?.length || 0} changed`, 'good');
      this.emit('broadcast', { type: 'skills_updated', skills: this.skillIndexFn?.() || null, source: this.skillsStatus() });
      this.skillsChanged?.(ss, e);
    });
    ss.on('pending', (st) => { this.toast(`A newer version of the skills library is available (${st.pending.added.length} new, ${st.pending.changed.length} changed). Review it in Settings.`, 'warn'); this.emit('broadcast', { type: 'skills_pending', source: this.skillsStatus() }); });
    ss.on('error_', (m) => this.addLog(`Skills update check failed: ${m}`, { type: 'system' }));
  },

  deptForSkills(skills) {
    const tally = {};
    for (const a of this.sim.agents.values()) for (const k of skills) if (a.skills.includes(k) && !a.hired) tally[a.dept] = (tally[a.dept] || 0) + 1;
    return Object.entries(tally).sort((x, y) => y[1] - x[1])[0]?.[0] || 'strategy';
  },

  async makeProfile(task, { role, skills, why, domain, dept, lead, gap = [] }) {
    const seed = `${role}|${domain || ''}|${this.seq.hire}`;
    const taken = new Set([...this.sim.agents.values()].map((a) => a.short.toLowerCase()));
    const nm = pickName(seed, taken);
    const tpl = HIRE_ROLES.find((r) => r.domain === domain || r.role.toLowerCase() === role.toLowerCase());
    const fromLib = skills.map((k) => this.skills[k]?.title || k).join(', ');
    const fallback = { first: nm.first, last: nm.last, persona: tpl?.persona || (gap.length ? `Built from the library's ${fromLib} playbook${skills.length > 1 ? 's' : ''}. Works strictly from that guidance, says so when a request falls outside it, and flags gaps instead of guessing.` : `${role}. Brings deep specialist knowledge${domain ? ` of ${domain}` : ''} and works closely with ${lead.short}. Prefers evidence to opinion and writes things down.`), quirks: tpl?.quirks || ['What does the evidence say?', 'Let me check that first.', 'Write it down so the next person can use it.'] };
    try {
      const res = await this.llm.complete({
        kind: 'hire', maxTokens: 400, ...this.toolkit(this.agent('vera'), task, { light: true }),
        system: this.personaSystem(this.agent('vera'), 'You are finalising a hire. Create a credible colleague profile.'),
        user: `New role: ${role}\nSkills they will own (from the skills library${gap.length ? `; the library has these playbooks but nobody on the team owned them: ${gap.join(', ')}` : ''}): ${skills.join(', ')}\nWhy we need them: ${why}\nDomain: ${domain || 'general'}\nTeam: ${DEPT_META[dept].label}, reporting to ${lead.name}\nFirst names already taken: ${[...taken].join(', ')}\n\nReply with JSON only: {"first":"first name","last":"last name","persona":"2 sentences: how they work and what they care about","quirks":["three short things they often say"]}`,
        ctx: { profile: fallback, title: role },
      });
      this.account(task || { tokens: 0, cost: 0 }, res);
      const j = res.simulated ? null : extractJson(res.text);
      if (j?.first && j?.last) {
        const first = String(j.first).replace(/[^\p{L} '-]/gu, '').trim().slice(0, 20); const last = String(j.last).replace(/[^\p{L} '-]/gu, '').trim().slice(0, 24);
        if (first && last && !taken.has(first.toLowerCase())) return { first, last, persona: clip(String(j.persona || fallback.persona), 300), quirks: (Array.isArray(j.quirks) ? j.quirks : fallback.quirks).map((q) => clip(String(q), 80)).slice(0, 4) };
      }
    } catch { /* template profile */ }
    return fallback;
  },

  async onboard(agent, task, lead) {
    const sim = this.sim; const vera = this.agent('nia') || this.agent('vera'); // People & Talent greets new hires
    await this.withAgent(agent, async (tok) => {
      sim.setStatus(agent, 'First day');
      await sim.goTo(agent, sim.map.spots.welcome, { tok });
      sim.say(vera, `Welcome, ${agent.short}. You report to ${lead.short}.`, 4); sim.say(lead, `Glad you're here, ${agent.short}. Read the team notes first.`, 4);
      sim.emoteFor(agent, 'heart', 3); agent.mood = Math.min(100, agent.mood + 15);
      await this.sleepSim(3.5, tok);
      await sim.goTo(agent, agent.desk.seat, { pose: 'sit', tok });
      this.onboardingNote(agent);
      agent.memory.push({ t: Math.round(sim.time), text: `Joined 4EVR as ${agent.role}. ${agent.why ? `Why: ${clip(agent.why, 100)}` : ''}`.trim() });
      agent.pose = 'type';
    });
  },

  /** Add a workstream to a running task (used when someone is hired mid-task). */
  addDynamicSubtask(task, agentId, skill, instruction, requestedBy) {
    const n = task.subtasks.length;
    const sub = { id: `${task.id}.${n + 1}`, idx: n, agent: agentId, skill, instruction: clip(String(instruction || 'Contribute your expertise to this task.'), 500), deps: [], consult: null, status: 'waiting', outputId: null, started: null, ended: null, headline: null, review: null, addedBy: requestedBy };
    task.subtasks.push(sub); this.pushTask(task); this.schedulers.get(task.id)?.();
    return sub;
  },

  async toolHire(a, task, input) {
    // a finished task (for example one being revised with God's answers) has no scheduler left to start a new workstream
    if (!task || !['planning', 'active', 'review'].includes(task.status)) return 'Could not hire: this task has already finished, so a new workstream would never start. Finish your own deliverable and suggest the hire in "Next actions" instead.';
    try {
      const agent = await this.hire(task, { role: input.role, skills: Array.isArray(input.skills) ? input.skills : [], need: input.need, why: input.why, domain: input.domain, assignment: input.assignment }, a.id);
      const named = (Array.isArray(input.skills) ? input.skills : []).some((k) => this.skills[k]);
      const skill = named ? bestSkill(this.skills, agent.skills, `${input.assignment} ${input.role}`) : agent.skills[0]; // a described need maps to its best-matching playbook
      const sub = this.addDynamicSubtask(task, agent.id, skill, input.assignment, a.id);
      return `Hired ${agent.name} (${agent.role}). Their workstream ${sub.id} is queued: "${clip(String(input.assignment || ''), 140)}". Their output goes into the final summary. Do not wait for it: state what you expect from them and carry on with your own deliverable.`;
    } catch (e) { if (e.cancelled) throw e; return `Could not hire: ${e.message}`; }
  },

  /** Planning-time hires. Live: the CMO's plan lists them. Simulated: rules read the brief and the site. */
  async applyHires(task, plan, rawHires) {
    if (this.hiringMode === 'off') return this.dropHireSteps(plan);
    await this.refreshSkills('planning');
    const mock = this.llm.mode === 'mock';
    const siteText = (task.sources || []).flatMap((s) => s.pages.map((p) => p.title)).join(' ');
    let specs;
    if (mock) {
      const text = `${task.title} ${task.brief} ${siteText}`;
      specs = hireRulesFor(text, this.existingDomains()).map((r) => ({ role: r.role, skills: r.skills, domain: r.domain, why: `The brief is in the ${r.domain} domain and nobody on the team has worked in it.`, assignment: r.step, dept: r.dept }));
      // someone hired for this domain on an earlier task is the right person: use them, do not hire again
      for (const r of HIRE_ROLES) {
        if (!r.re.test(text)) continue;
        const known = [...this.sim.agents.values()].find((a) => a.hired && a.domains?.includes(r.domain));
        if (!known || plan.steps.some((st) => st.agent === known.id)) continue;
        this.insertLeadingStep(plan, known.id, this.skills[r.step[0]] ? r.step[0] : known.skills[0], r.step[1]);
        this.talk(task, { from: 'vera', to: 'all', kind: 'hire', text: `${known.short} already knows the ${r.domain} domain from earlier work, so I am putting them on this instead of hiring.` });
      }
      // library playbooks that nobody on the team owns (for example new upstream skills) and that this brief needs
      for (const g of this.skillGapSpecs(text)) if (specs.length < 2) specs.push(g);
    }
    else specs = (Array.isArray(rawHires) ? rawHires : []).slice(0, this.hiringCaps.perTask).map((h) => ({ role: h.role, skills: h.skills, domain: h.domain, why: h.why, assignment: h.assignment }));
    const made = [];
    for (const [i, spec] of specs.entries()) {
      try {
        const agent = await this.hire(task, spec, 'vera');
        made[i] = agent;
        if (mock) {
          const [skill, instruction] = Array.isArray(spec.assignment) ? spec.assignment : [agent.skills[0], spec.assignment || 'Contribute your expertise.'];
          this.insertLeadingStep(plan, agent.id, this.skills[skill] ? skill : agent.skills[0], instruction);
        }
      } catch (e) {
        if (e.cancelled) throw e;
        this.addLog(`Could not hire a ${spec.role}: ${e.message}`, { type: 'system', taskId: task.id }); this.talk(task, { from: 'vera', to: 'all', kind: 'hire', text: `I looked at hiring a ${spec.role} but: ${e.message}` });
      }
    }
    if (!mock) {
      for (const st of plan.steps) {
        const m = /^hire:(\d+)$/.exec(st.agent || '');
        if (m) { const ag = made[Number(m[1])]; st.agent = ag ? ag.id : this.bestExisting(st.skill, st.instruction); }
      }
    }
    return this.dropHireSteps(plan);
  },

  dropHireSteps(plan) { for (const st of plan.steps) if (/^hire:\d+$/.test(st.agent || '')) st.agent = this.bestExisting(st.skill, st.instruction); return plan; },
  bestExisting(skill, text) {
    const owners = [...this.sim.agents.values()].filter((a) => a.skills.includes(skill));
    return (owners.sort((x, y) => this.load_of(x.id) - this.load_of(y.id))[0] || this.agent('vera')).id;
  },

  /** The new person's domain brief goes first and feeds the people who write, plan and sell. */
  insertLeadingStep(plan, agentId, skill, instruction) {
    plan.steps.forEach((st) => { st.deps = st.deps.map((d) => d + 1); });
    plan.steps.unshift({ agent: agentId, skill, instruction, deps: [], consult: null });
    const feeds = new Set(['copywriting', 'ads', 'cro', 'cold-email', 'emails', 'social', 'ad-creative', 'content-strategy', 'offers', 'lead-magnets', 'public-relations', 'prospecting']);
    plan.steps.forEach((st, i) => { if (i > 0 && feeds.has(st.skill) && !st.deps.includes(0)) st.deps.push(0); });
    plan.summary = `${plan.summary} (with a new domain specialist briefing the team first)`;
  },

  // ---------- approval mode ----------
  awaitHireApproval(task, spec, requesterId) {
    return new Promise((resolve, reject) => {
      const id = `HR${++this.seq.hireReq}`;
      const req = { id, taskId: task?.id || null, role: spec.role, skills: spec.skills, why: clip(String(spec.why || ''), 240), by: requesterId, created: Date.now() };
      const timer = setTimeout(() => { if (this.hireRequests.delete(id)) { this.emit('broadcast', { type: 'hire_resolved', id, ok: false }); reject(new Error('No answer from God in 10 minutes, so the hire was not made.')); } }, 10 * 60 * 1000);
      this.hireRequests.set(id, { req, resolve: () => { clearTimeout(timer); resolve(); }, reject: (m) => { clearTimeout(timer); reject(new Error(m)); } });
      this.emit('broadcast', { type: 'hire_request', req });
      this.toast(`${this.agent(requesterId)?.short || 'Someone'} wants to hire a ${spec.role}. Approve in the Team tab.`, 'warn');
      this.talk(task, { from: requesterId, to: 'god', kind: 'hire', text: `Requesting approval to hire a ${spec.role}: ${req.why}` });
    });
  },
  pendingHires() { return [...this.hireRequests.values()].map((x) => x.req); },
  decideHire(id, ok) {
    const h = this.hireRequests.get(id); if (!h) return false;
    this.hireRequests.delete(id); this.emit('broadcast', { type: 'hire_resolved', id, ok: !!ok });
    if (ok) h.resolve(); else h.reject('God declined the hire.');
    return true;
  },

  /** God hires someone directly, outside any task. */
  async godHire({ role, skills, why, domain, need }) {
    const list = (Array.isArray(skills) ? skills : String(skills || '').split(/[,\s]+/)).map((s) => s.trim()).filter(Boolean);
    const agent = await this.hire(null, { role, skills: list, need, why: why || 'Hired by God.', domain: domain || null, capacity: true }, 'god');
    return agent;
  },

  async fire(id) {
    const a = this.agent(id); if (!a?.hired) throw new Error('Only people who were hired can be let go.');
    if (a.busy) throw new Error(`${a.short} is working right now.`);
    const assigned = [...this.tasks.values()].some((t) => t.assignee === id && ['queued', 'researching', 'planning', 'active', 'review', 'stopping'].includes(t.status));
    if (this.load_of(id) > 0 || assigned) throw new Error(`${a.short} still has work assigned.`);
    this.kb.inherit?.(id, a.dept);
    this.talk(null, { from: 'god', to: id, kind: 'hire', text: `${a.name} has been let go. What they learned stays with the team.` });
    this.hires.delete(id); this.sim.removeAgent(id);
    this.emit('broadcast', { type: 'agent_removed', id, hiring: this.hiringStatus() });
    this.addLog(`${a.name} (${a.role}) was let go`, { type: 'system' });
  },
};
