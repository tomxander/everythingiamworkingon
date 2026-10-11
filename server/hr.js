// People & Talent: Nia (Head of People & Talent) and Tomás (Talent Intelligence & Skills Analyst).
// Method comes from the hr-skills library (job descriptions, onboarding plans, performance reviews, workforce
// planning), adapted to a team made of AI agents. What stays in code, not with the agents: the hiring caps, the
// numbers in every review and report, and the rule that a release (firing) always needs God's approval.
import { skillPrompt } from './skills.js';
import { extractJson } from './llm.js';

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pct = (x) => `${Math.round(x * 100)}%`;
const REPORT_EVERY = 5; // a workforce report after this many finished tasks

export const hr = {
  hrState() { return (this.hr ||= { reviews: [], reports: [], releases: [], seq: { review: 0, report: 0, release: 0 }, lastReportAt: 0, skillNotes: [] }); },
  nia() { return this.agent('nia'); },
  tomas() { return this.agent('tomas'); },

  // ---------- requisition: job description + 30/60/90 plan, produced when a hire is approved ----------
  async hrRequisition(task, { role, skills, why, dept, lead, gap = [], domain }) {
    const nia = this.nia(); const titles = skills.map((k) => this.skills[k]?.title || k);
    const doing = skills.map((k) => `- ${this.skills[k]?.title || k}: ${clip(this.skills[k]?.summary || '', 120)}`).join('\n');
    const fallback = {
      jd: `# ${role}\n\n**Reports to:** ${lead.name} (${lead.role})  \n**Team:** ${dept}\n\n## Why this role exists\n${clip(why || 'The work needs expertise the team does not have.', 240)}\n\n## What you own\n${doing}\n\n## Working rules\n- You work only from the playbooks above and the evidence in each client context; you cannot log in to client systems.\n- Every deliverable ends with next actions and how we will know it worked.\n\n## Success looks like\n- First-pass peer-review approval on at least 80% of your deliverables.\n- At least one lesson saved that another teammate reuses.`,
      plan: [
        { phase: 'First 30 days', goals: [`Read the ${titles.join(', ')} playbook${skills.length > 1 ? 's' : ''} and their references`, `Shadow ${lead.short} on one live task`, 'Read the house playbooks and the team lessons'] },
        { phase: 'Days 31 to 60', goals: ['Own a workstream end to end', 'Ask teammates for input before drafting, not after', 'Save at least one lesson'] },
        { phase: 'Days 61 to 90', goals: ['Reach 80% first-pass approval', 'Review one teammate\'s work', 'Propose one improvement to the playbook'] },
      ],
    };
    let out = fallback;
    try {
      const ref = this.skills['hr-job-description'];
      const res = await this.llm.complete({
        kind: 'hr', maxTokens: 900, ctx: { fallback: JSON.stringify(fallback) },
        system: this.personaSystem(nia, `You are writing a job description and a 30/60/90 onboarding plan for a new AI-agent colleague. Use the playbook below for structure, but leave out anything that only applies to human employees (salary, benefits, labour law, location). The new colleague works only from the skills listed.\n\n${ref ? skillPrompt(ref, 6000) : ''}`),
        user: `Role: ${role}\nReports to: ${lead.name}, ${lead.role}\nTeam: ${dept}\nSkills they own: ${skills.join(', ')}\nWhy we need them: ${why || 'n/a'}${domain ? `\nDomain: ${domain}` : ''}\n\nReply with JSON only: {"jd":"markdown job description, under 300 words, starting with a # title","plan":[{"phase":"First 30 days","goals":["…"]},{"phase":"Days 31 to 60","goals":["…"]},{"phase":"Days 61 to 90","goals":["…"]}]}`,
      });
      this.account(task || { tokens: 0, cost: 0 }, res);
      const j = res.simulated ? null : extractJson(res.text);
      if (j && typeof j.jd === 'string' && j.jd.length > 80 && Array.isArray(j.plan) && j.plan.length >= 3) {
        out = { jd: clip(j.jd, 3000), plan: j.plan.slice(0, 3).map((p, i) => ({ phase: clip(String(p.phase || fallback.plan[i].phase), 40), goals: (Array.isArray(p.goals) ? p.goals : fallback.plan[i].goals).slice(0, 5).map((g) => clip(String(g), 160)) })) };
      }
    } catch { /* the template requisition stands */ }
    this.sim.say(nia, `Requisition open: ${clip(role, 30)}`, 4);
    this.talk(task, { from: 'nia', to: 'all', kind: 'hire', text: `Requisition for ${role}: job description and a 30/60/90 plan written. Reports to ${lead.short}.` });
    return { ...out, by: 'nia', at: Date.now() };
  },

  /** Nia greets the new hire and hands over the plan (the walk and the welcome are in hiring.onboard). */
  onboardingNote(agent) {
    const p = agent.onboarding; if (!p) return;
    agent.memory.push({ t: Math.round(this.sim.time), text: `Onboarding plan from Nia. ${p.map((x) => `${x.phase}: ${x.goals[0]}`).join(' | ')}`.slice(0, 400) });
  },

  // ---------- facts: everything in a review or report is counted from real records ----------
  perfFacts(a) {
    const subs = []; for (const t of this.tasks.values()) for (const s of t.subtasks) if (s.agent === a.id && s.status === 'done') subs.push(s);
    const reviewed = subs.filter((s) => s.review); const approved = reviewed.filter((s) => s.review.verdict !== 'revise');
    const lessons = this.kb.active().filter((l) => l.scope === 'agent' && l.agent === a.id).length;
    return {
      id: a.id, name: a.name, role: a.role, dept: a.dept, hired: !!a.hired, delivered: subs.length, reviewed: reviewed.length,
      firstPass: reviewed.length ? approved.length / reviewed.length : null, revisions: subs.filter((s) => s.revised).length,
      consults: a.stats.consults || 0, tokens: a.stats.tokens || 0, lessons, load: this.load_of(a.id),
    };
  },
  /** The rating is a rule, not a mood: God can audit it. */
  rate(f) {
    if (f.reviewed < 3) return 'Too early to rate';
    if (f.firstPass >= 0.9) return 'Exceeds expectations';
    if (f.firstPass >= 0.7) return 'Meets expectations';
    return 'Needs development';
  },

  async performanceReview(id, { by = 'nia' } = {}) {
    const a = this.agent(id); if (!a) throw new Error('No such person.');
    const nia = this.nia(); const f = this.perfFacts(a); const rating = this.rate(f);
    const factLines = [`Deliverables: ${f.delivered}`, `Peer-reviewed: ${f.reviewed}`, `First-pass approval: ${f.firstPass === null ? 'n/a' : pct(f.firstPass)}`, `Revisions requested: ${f.revisions}`, `Teammate consults: ${f.consults}`, `Lessons saved: ${f.lessons}`];
    const strengths = []; const growth = [];
    if (f.firstPass !== null && f.firstPass >= 0.8) strengths.push(`${pct(f.firstPass)} of peer-reviewed work was approved first time`);
    if (f.consults >= 2) strengths.push(`works with the team (${f.consults} consults)`);
    if (f.lessons >= 1) strengths.push(`${f.lessons} lesson${f.lessons > 1 ? 's' : ''} saved for others`);
    if (f.firstPass !== null && f.firstPass < 0.7) growth.push('Raise first-pass approval: re-read the client context against each claim before handing over');
    if (f.revisions >= 2) growth.push(`${f.revisions} deliverables needed revision: check the reviewer's last finding before starting the next one`);
    if (f.reviewed < 3) growth.push('Not enough reviewed work yet for a rating: take on more workstreams');
    if (f.lessons === 0 && f.delivered >= 2) growth.push('Save a lesson after each task so the next one starts ahead');
    let narrative = `${a.short}: ${rating}. ${strengths.length ? `Strengths: ${strengths.join('; ')}. ` : ''}${growth.length ? `To work on: ${growth.join('; ')}.` : 'No development areas this period.'}`;
    try {
      const ref = this.skills['hr-performance-management'];
      const res = await this.llm.complete({
        kind: 'hr', maxTokens: 500, ctx: { fallback: narrative },
        system: this.personaSystem(nia, `You are writing a short, fair performance review of an AI-agent colleague. Use only the facts given; invent nothing. The rating is fixed by the numbers: do not change it. Three to five sentences, plain text.\n\n${ref ? skillPrompt(ref, 4000) : ''}`),
        user: `Colleague: ${a.name}, ${a.role}\nRating (fixed): ${rating}\nFacts:\n${factLines.join('\n')}\nStrengths found: ${strengths.join('; ') || 'none yet'}\nDevelopment areas: ${growth.join('; ') || 'none'}`,
      });
      this.account({ tokens: 0, cost: 0 }, res);
      if (!res.simulated && res.text.trim().length > 30) narrative = clip(res.text.trim(), 900);
    } catch { /* the factual narrative stands */ }
    const st = this.hrState(); const rev = { id: `R${++st.seq.review}`, agent: a.id, name: a.name, role: a.role, by, at: Date.now(), rating, facts: f, factLines, strengths, growth, narrative };
    st.reviews.unshift(rev); st.reviews = st.reviews.slice(0, 80);
    // development areas become lessons the person actually sees in future prompts
    for (const g of growth.slice(0, 2)) if (f.reviewed >= 3 || g.startsWith('Save')) this.kb.add({ scope: 'agent', agent: a.id, skill: a.skills[0], text: g, source: 'hr', kind: 'lesson', tags: ['performance'] });
    this.sim.say(nia, `Review done: ${a.short} (${rating})`, 4);
    this.talk(null, { from: 'nia', to: a.id, kind: 'review', text: narrative });
    this.addLog(`Performance review: ${a.name}, ${rating}`, { type: 'system', agent: 'nia' });
    this.releaseCheck(a, rev);
    this.emit('broadcast', { type: 'hr', hr: this.hrPublic() });
    this.save();
    return rev;
  },

  async reviewAll() { const out = []; for (const a of this.sim.agents.values()) { if (a.id === 'nia') continue; out.push(await this.performanceReview(a.id)); } return out; },

  // ---------- releases: HR may propose, only God decides ----------
  releaseCheck(a, rev) {
    if (!a.hired || rev.facts.reviewed < 3) return;
    const prior = this.hrState().reviews.filter((r) => r.agent === a.id && r.id !== rev.id && r.rating !== 'Too early to rate')[0];
    if (rev.rating !== 'Needs development' || prior?.rating !== 'Needs development') return;
    this.proposeRelease(a, `Rated "Needs development" in two consecutive reviews (first-pass approval ${pct(rev.facts.firstPass)}).`, rev.facts);
  },
  proposeRelease(a, reason, facts = null) {
    const st = this.hrState(); if (st.releases.some((r) => r.agent === a.id && r.status === 'pending')) return null;
    if (!a.hired) return null; // the founding team is never proposed for release
    const r = { id: `X${++st.seq.release}`, agent: a.id, name: a.name, role: a.role, reason: clip(reason, 300), facts, status: 'pending', at: Date.now() };
    st.releases.unshift(r);
    this.talk(null, { from: 'nia', to: 'god', kind: 'hire', text: `I'm proposing we let ${a.name} go: ${r.reason} Nothing happens until you approve.` });
    this.toast(`HR proposes releasing ${a.name}. Needs your decision.`, 'warn');
    this.emit('broadcast', { type: 'hr', hr: this.hrPublic() });
    return r;
  },
  async decideRelease(id, approve) {
    const r = this.hrState().releases.find((x) => x.id === id && x.status === 'pending'); if (!r) throw new Error('No pending release with that id.');
    if (!approve) { r.status = 'declined'; r.decided = Date.now(); this.emit('broadcast', { type: 'hr', hr: this.hrPublic() }); this.save(); return r; }
    await this.fire(r.agent); // fire() has its own checks: only hired people, not mid-work, nothing assigned
    r.status = 'approved'; r.decided = Date.now(); this.emit('broadcast', { type: 'hr', hr: this.hrPublic() }); this.save();
    return r;
  },

  // ---------- workforce report ----------
  workforceFacts() {
    const agents = [...this.sim.agents.values()]; const teams = {};
    for (const a of agents) { const t = (teams[a.dept] ||= { people: 0, skills: new Set(), delivered: 0 }); t.people++; a.skills.forEach((s) => t.skills.add(s)); t.delivered += a.stats.deliverables || 0; }
    const perAgent = agents.map((a) => this.perfFacts(a));
    const worked = perAgent.filter((f) => f.delivered > 0); const mean = worked.length ? worked.reduce((n, f) => n + f.delivered, 0) / worked.length : 0;
    const unowned = { marketing: this.skillGaps('marketing').length, hr: this.skillGaps('hr').length };
    const hired = agents.filter((a) => a.hired);
    return { headcount: agents.length, caps: this.hiringCaps, hiredNow: hired.length, perAgent, mean, busiest: worked.filter((f) => mean && f.delivered >= mean * 1.5 && f.delivered >= 3), idleHires: hired.filter((a) => (a.stats.deliverables || 0) === 0 && this.completed >= 3).map((a) => a.id), teams: Object.fromEntries(Object.entries(teams).map(([k, v]) => [k, { people: v.people, skills: v.skills.size, delivered: v.delivered }])), unowned, libs: this.skillsStatus() };
  },
  async workforceReport({ reason = 'on request' } = {}) {
    const nia = this.nia(); const tomas = this.tomas(); const st = this.hrState(); const f = this.workforceFacts();
    const rec = [];
    for (const b of f.busiest) rec.push(`${b.name} has delivered ${b.delivered} workstreams against a team average of ${f.mean.toFixed(1)}. If their queue keeps growing, hire into ${b.dept} rather than overloading them.`);
    for (const id of f.idleHires) rec.push(`${this.agent(id)?.name || id} has delivered nothing since joining. Review whether the role is still needed; any release needs your approval.`);
    if (f.headcount >= f.caps.headcount * 0.8) rec.push(`Headcount is ${f.headcount} of ${f.caps.headcount}. Plan which hires can be released before adding more.`);
    if (f.hiredNow >= f.caps.total * 0.75) rec.push(`${f.hiredNow} of ${f.caps.total} lifetime hires used.`);
    if (!rec.length) rec.push('No staffing action recommended. Coverage and load are within normal range.');
    const rows = f.perAgent.map((p) => `| ${p.name} | ${p.role} | ${p.delivered} | ${p.firstPass === null ? 'n/a' : pct(p.firstPass)} | ${p.load} |`).join('\n');
    const teamRows = Object.entries(f.teams).map(([k, v]) => `| ${k} | ${v.people} | ${v.skills} | ${v.delivered} |`).join('\n');
    const libs = f.libs.map((l) => `- ${l.id}: ${l.repo || 'vendored copy'} at ${l.commit ? String(l.commit).slice(0, 7) : 'vendored'} (${l.mode})`).join('\n');
    const md = `# Workforce report\n\n_${new Date().toISOString().slice(0, 10)}, ${reason}. Prepared by Nia Abara with Tomás Lindqvist. All numbers are counted from task records; the "Recommendations" are judgement._\n\n## Headcount\n${f.headcount} of ${f.caps.headcount} desks. ${f.hiredNow} hired so far (limit ${f.caps.total}).\n\n## People\n| Name | Role | Delivered | First-pass approval | Open work |\n|---|---|---|---|---|\n${rows}\n\n## Teams\n| Team | People | Skills owned | Delivered |\n|---|---|---|---|\n${teamRows}\n\n## Skills library\nSkills in the library that nobody on the team owns: ${f.unowned.marketing} marketing, ${f.unowned.hr} HR. These are hireable capabilities, not problems.\n${libs}\n\n## Recommendations\n${rec.map((r) => `- ${r}`).join('\n')}\n\n## Next actions\n- Nia: decide on the recommendations above and raise any release with God.\n- Tomás: re-run this report after ${REPORT_EVERY} more finished tasks.\n\n## How we'll know it worked\nFirst-pass approval stays at or above 80% while no one carries more than 1.5× the team's average load.`;
    const pseudo = { id: 'HR' }; const sub = { id: `HR.${st.seq.report + 1}`, skill: 'hr-workforce-planning' };
    const d = this.saveDeliverable(pseudo, sub, nia, { text: md, usage: { input: 0, output: 0 }, simulated: this.llm.mode === 'mock' }, 'hr');
    const rep = { id: `W${++st.seq.report}`, at: Date.now(), reason, deliverable: d.id, recommendations: rec, headcount: f.headcount, hired: f.hiredNow };
    st.reports.unshift(rep); st.reports = st.reports.slice(0, 20); st.lastReportAt = this.completed;
    this.sim.say(tomas, 'Workforce numbers are in', 4); this.sim.say(nia, 'Report is up in Output', 4);
    this.talk(null, { from: 'nia', to: 'god', kind: 'hire', text: `Workforce report ready (${rec.length} recommendation${rec.length > 1 ? 's' : ''}). Top one: ${clip(rec[0], 140)}` });
    this.addLog(`Workforce report ${rep.id}`, { type: 'system', agent: 'nia' });
    this.emit('broadcast', { type: 'hr', hr: this.hrPublic() });
    this.save();
    return rep;
  },

  /** After each finished task: a report every few tasks, a review for any hire that has done enough work. */
  async hrAfterTask() {
    const st = this.hrState();
    if (this.completed - st.lastReportAt >= REPORT_EVERY) await this.workforceReport({ reason: `after ${this.completed} finished tasks` });
    for (const a of this.sim.agents.values()) {
      if (!a.hired) continue; const f = this.perfFacts(a); const last = st.reviews.find((r) => r.agent === a.id);
      if (f.reviewed >= 3 && (!last || f.reviewed - (last.facts.reviewed || 0) >= 3)) await this.performanceReview(a.id);
    }
  },

  // ---------- Tomás watches the skills libraries ----------
  skillsChanged(ss, e) {
    if (!e) return; const st = this.hrState(); const tomas = this.tomas(); if (!tomas) return;
    const added = e.added?.length || 0, changed = e.changed?.length || 0, removed = e.removed?.length || 0;
    if (!added && !changed && !removed) return;
    const text = `${ss.id} skills library updated: ${added} added, ${changed} changed, ${removed} removed${e.added?.length ? ` (new: ${e.added.slice(0, 4).join(', ')}${added > 4 ? '…' : ''})` : ''}. Unowned skills now: ${this.skillGaps(ss.id).length}.`;
    st.skillNotes.unshift({ t: Date.now(), library: ss.id, text }); st.skillNotes = st.skillNotes.slice(0, 20);
    this.sim.say(tomas, 'Library updated', 3);
    this.talk(null, { from: 'tomas', to: 'nia', kind: 'hire', text });
  },

  // ---------- views ----------
  /** Short facts for the CMO's planner: who is stretched, how much room there is to hire. */
  hrSnapshotText() {
    const f = this.workforceFacts(); const busy = f.busiest.map((b) => `${b.name} (${b.delivered} done)`).join(', ');
    return `Workforce: ${f.headcount}/${f.caps.headcount} desks, ${f.hiredNow}/${f.caps.total} hires used.${busy ? ` Stretched: ${busy}.` : ''} People & Talent (Nia, Tomás) only take HR, hiring or workforce work.`;
  },
  hrPublic() {
    const st = this.hrState(); const f = this.workforceFacts();
    return { reviews: st.reviews.slice(0, 20), reports: st.reports.slice(0, 5), releases: st.releases.slice(0, 10), skillNotes: st.skillNotes.slice(0, 8), facts: { headcount: f.headcount, caps: f.caps, hiredNow: f.hiredNow, unowned: f.unowned, mean: Number(f.mean.toFixed(1)) } };
  },
  hrSave() { const s = this.hrState(); return { reviews: s.reviews, reports: s.reports, releases: s.releases, seq: s.seq, lastReportAt: s.lastReportAt, skillNotes: s.skillNotes }; },
  hrLoad(d) { if (d) Object.assign(this.hrState(), d, { seq: { ...this.hrState().seq, ...(d.seq || {}) } }); },
};
