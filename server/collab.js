// How the company talks to itself. Mixed into Company.
//   - org: every agent has a team and a lead; feedback goes through the lead first
//   - kickoff: before work starts, the owners are briefed and say what they need from each other
//   - thread: everything said about a task goes into a shared channel the agents read before working
//   - handoffs: finished work is handed to the next owner in person, with what they must know
//   - alignment: before the summary, Vera looks for real conflicts between deliverables and decides
//   - escalation: failed work goes to the lead, then gets one retry or is cut with a note
import { REQUEST_TOOL } from './inbox.js';
import fs from 'node:fs';
import path from 'node:path';
import { COMPANY } from './roster.js';
import { extractJson } from './llm.js';
import { TOOL_DEFS, makeToolHandler } from './tools.js';

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const uniq = (a) => [...new Set(a)];
const THREAD_KINDS = new Set(['kickoff', 'handoff', 'decision', 'consult', 'review', 'status', 'question', 'retro', 'hire']);

const ASK_TOOL = { name: 'ask_teammate', description: 'Ask a colleague a specific question and get their answer now. Use it when another specialist knows something you need (their findings, constraints or opinion). Name them by id or first name.', input_schema: { type: 'object', properties: { to: { type: 'string', description: 'The teammate, for example "dee" or "Camila".' }, question: { type: 'string', description: 'One specific question.' } }, required: ['to', 'question'] } };
const HIRE_TOOL = { name: 'request_hire', description: 'Bring a new specialist onto the team when the work needs expertise or capacity nobody here has. The specialist is built from playbooks in the skills library, which is checked against its upstream repository first. Only use it when no existing teammate can do the job. Say exactly what the new person should produce.', input_schema: { type: 'object', properties: { role: { type: 'string', description: 'Job title, e.g. "Marine Industry Strategist".' }, skills: { type: 'array', items: { type: 'string' }, description: 'Skills from the library this person should own. If you do not know the names, describe the need instead.' }, need: { type: 'string', description: 'Describe the capability needed in plain words; the matching library playbooks are found for you.' }, why: { type: 'string', description: 'Why no current teammate can do this.' }, assignment: { type: 'string', description: 'The deliverable you want from them for this task.' }, domain: { type: 'string', description: 'Optional one-word industry or domain, e.g. "automotive".' } }, required: ['role', 'why', 'assignment'] } };
const SAVE_TOOL = { name: 'save_lesson', description: 'Record one reusable lesson for next time: something that worked, failed or surprised you, written as a short instruction to your future self. Do not include client secrets or links.', input_schema: { type: 'object', properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, scope: { type: 'string', enum: ['agent', 'team', 'client'] } }, required: ['text'] } };
const RECALL_TOOL = { name: 'recall_lessons', description: 'Search what the team has learned from past work.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };

export const collab = {
  // ------------------------------------------------------------ org
  leadOf(id) { const a = this.agent(id); return a?.reportsTo ? this.agent(a.reportsTo) : null; },
  teamOf(id) { const a = this.agent(id); return [...this.sim.agents.values()].filter((x) => x.dept === a?.dept); },

  personaSystem(a, extra = '') {
    const rules = this.kb.rules().map((r) => `- ${r.text}`).join('\n');
    return `${COMPANY.charter}\n\nYou are ${a.name}, ${a.role} at 4EVR${a.reportsTo ? `, reporting to ${this.agent(a.reportsTo)?.name || 'the CMO'}` : ''}. ${a.persona}${rules ? `\n\nCompany operating principles:\n${rules}` : ''}${extra ? `\n\n${extra}` : ''}`;
  },

  // ------------------------------------------------------------ the task channel
  talk(task, m) {
    const msg = { from: m.from, to: m.to || 'all', text: m.text, kind: m.kind || 'task', taskId: task?.id };
    this.emit('comms', msg);
    if (task && THREAD_KINDS.has(msg.kind)) { (task.thread ||= []).push({ from: msg.from, to: msg.to, kind: msg.kind, text: clip(msg.text, 700), t: Math.round(this.sim.time) }); if (task.thread.length > 90) task.thread.shift(); }
  },

  /** What has been said about this task that `forId` should read before they start. */
  threadText(task, forId, max = 3600) {
    const items = (task.thread || []).filter((m) => m.to === 'all' || m.to === forId || m.from === forId || m.kind === 'decision' || m.kind === 'kickoff' || m.kind === 'hire');
    if (!items.length) return '';
    const name = (id) => (id === 'god' ? 'God' : id === 'all' ? 'the team' : this.agent(id)?.short || id);
    const lines = []; let used = 0;
    for (const m of items.slice(-30).reverse()) { const l = `[${m.kind}] ${name(m.from)} → ${name(m.to)}: ${m.text}`; if (used + l.length > max) break; lines.push(l); used += l.length; }
    return lines.reverse().join('\n');
  },

  newMeeting(task, type, title, participants) {
    const m = { id: `${task.id}.M${(task.meetings?.length || 0) + 1}`, type, title, at: Date.now(), participants: uniq(participants), turns: [], summary: null };
    (task.meetings ||= []).push(m); this.pushTask(task); return m;
  },

  /** Pull the free people in the meeting to the council table. Busy people dial in. */
  async seat(host, attendees, tok) {
    const sim = this.sim; const seats = sim.map.spots.council; const order = [2, 0, 1, 3, 4, 5, 8, 9, 6, 7, 10, 11];
    const free = attendees.filter((a) => a.id !== host.id && !a.busy && !a.ambientLock);
    free.forEach((a) => { a.ambientLock = true; sim.claim(a); });
    const jobs = [sim.goTo(host, { ...seats[order[0]] }, { pose: 'sit', tok })];
    free.forEach((a, i) => jobs.push(sim.goTo(a, { ...seats[order[(i + 1) % order.length]] }, { pose: 'sit', tok: a.tok })));
    await Promise.all(jobs);
    return free;
  },
  release(free) { for (const a of free) { a.ambientLock = false; a.pose = 'stand'; this.sim.setStatus(a, 'Available'); } },

  async speak(task, m, a, text, { kind = 'kickoff', to = 'all', tok }) {
    m.turns.push({ agent: a.id, text: clip(text, 700) });
    this.talk(task, { from: a.id, to, text, kind });
    this.sim.say(a, text, Math.min(9, 3 + text.length / 24)); a.pose = 'talk';
    this.pushTask(task);
    await this.sleepSim(Math.min(8, Math.max(2.5, text.split(/\s+/).length / 2.6)), tok);
    if (!a.busy || a.id === 'vera') a.pose = 'sit';
  },

  // ------------------------------------------------------------ kickoff
  async kickoff(task) {
    if (this.collab === 'off' || task.subtasks.length < 2) return;
    const vera = this.agent('vera'); const sim = this.sim;
    const info = task.subtasks.map((s) => ({ idx: s.idx, agent: s.agent, short: this.agent(s.agent).short, skill: s.skill, instruction: s.instruction, deps: s.deps.map((d) => this.agent(task.subtasks[d].agent).short) }));
    const owners = uniq(task.subtasks.map((s) => s.agent)).filter((id) => id !== 'vera');
    const leads = owners.filter((id) => this.agent(id).lead);
    // full: every owner speaks (leads first). lean: only the leads, to keep the number of model calls down.
    const speakers = this.collab === 'lean' ? (leads.length ? leads : owners.slice(0, 1)) : [...leads, ...owners.filter((id) => !this.agent(id).lead)];
    const m = this.newMeeting(task, 'kickoff', `Kickoff: ${clip(task.title, 50)}`, ['vera', ...speakers]);
    let free = [];
    try {
      await this.withAgent(vera, async (tok) => {
        sim.setStatus(vera, `Running the ${task.id} kickoff`);
        free = await this.seat(vera, speakers.map((id) => this.agent(id)), tok);
        const planText = info.map((x) => `- ${x.short}: ${x.skill} — ${x.instruction}${x.deps.length ? ` (after ${x.deps.join(', ')})` : ''}`).join('\n');
        const tk = this.toolkit(vera, task, { light: true });
        const brief = await this.llm.complete({
          kind: 'kickoff_brief', maxTokens: 350, ...tk,
          system: this.personaSystem(vera, `You are opening the kickoff meeting for a piece of client work. Speak to the team in plain, direct language.`),
          user: `${this.contextText(task, 3500)}\n\n## The plan\n${planText}\n\nOpen the meeting in 3 to 5 sentences: restate the objective and the one metric, say who does what and what hands off to whom, name the single biggest risk, and ask each owner to confirm and say what they need from each other. No headings, no lists.`,
          ctx: { title: task.title, intake: task.intake, steps: info },
        });
        this.account(task, brief); if (brief.simulated) await this.sleepSim(1.5, tok);
        await this.speak(task, m, vera, brief.text, { tok });
        for (const id of speakers) {
          const a = this.agent(id); const mine = info.filter((x) => x.agent === id);
          const as = mine[0]; if (!as) continue;
          const lead = this.leadOf(id); const leadTurn = lead && m.turns.find((t) => t.agent === lead.id);
          const needsFrom = uniq(mine.flatMap((x) => x.deps)); const feedsInto = uniq(info.filter((x) => x.deps.includes(a.short) && x.agent !== id).map((x) => x.short));
          const risk = { analytics: 'we have no baseline to compare against', cro: 'changes landing on the same page at the same time', copywriting: 'writing before the evidence is in', ads: 'spending before the offer is settled', 'seo-audit': 'we only see the site from outside', 'lead-magnets': 'building an asset nobody asked for', 'customer-research': 'sample bias in what we can see' }[as.skill] || 'an unclear baseline';
          const tk2 = this.toolkit(a, task, { light: true });
          const reply = await this.llm.complete({
            kind: 'kickoff_reply', maxTokens: 220, ...tk2,
            system: this.personaSystem(a, `You are in the kickoff meeting. Reply in first person, 2 to 3 sentences. You may use web_search or fetch_url if you need to check a fact first, otherwise just answer.`),
            user: `## Meeting so far\n${m.turns.map((t) => `${this.agent(t.agent).short}: ${t.text}`).join('\n')}\n\n## Your assignment\n${as.skill}: ${as.instruction}\nYou depend on: ${needsFrom.join(', ') || 'nobody'}. Depends on you: ${feedsInto.join(', ') || 'nobody'}.${leadTurn ? `\nYour lead ${lead.short} said: "${leadTurn.text}"` : ''}\n\nGive your approach, anything you need from a named teammate (and by when), and one real risk. If someone already said something that affects you, answer it by name.`,
            ctx: { title: task.title, agent: { short: a.short, quirks: a.quirks }, assignment: { skill: as.skill, instruction: as.instruction }, needsFrom, feedsInto, leadNote: leadTurn ? { short: lead.short, text: leadTurn.text } : null, risk },
          });
          this.account(task, reply); if (reply.simulated) await this.sleepSim(0.8, tok);
          a.dir = 'down'; await this.speak(task, m, a, reply.text, { tok });
          a.memory.push({ t: Math.round(sim.time), text: `Kickoff for "${clip(task.title, 40)}": committed to ${as.skill}` });
        }
        await this.speak(task, m, vera, 'Good. Go.', { tok });
        m.summary = `${speakers.length} owners confirmed their plan and dependencies.`;
      });
    } finally { this.release(free); this.pushTask(task); }
    this.addLog(`Kickoff held for ${task.id} with ${speakers.length} owners`, { type: 'task', taskId: task.id, agent: 'vera' });
  },

  // ------------------------------------------------------------ handoffs (called while the author still holds themselves)
  async handoffs(task, sub, author, deliverable, tok) {
    const sim = this.sim; const lead = this.leadOf(author.id);
    const down = task.subtasks.filter((x) => x.deps.includes(sub.idx) && x.agent !== author.id).slice(0, 3);
    if (this.collab !== 'off') {
      for (const ds of down) {
        const b = this.agent(ds.agent); if (!b) continue;
        const assumption = (deliverable.markdown.match(/## Assumptions\n([\s\S]*?)(?:\n##|$)/) || [])[1]?.split('\n').find((l) => l.trim().startsWith('-'))?.replace(/^-\s*/, '').trim();
        const tk = this.toolkit(author, task, { light: true });
        const lean = this.collab === 'lean';
        const res = lean ? { text: `${b.short}, handing you my ${sub.skill}. Headline: ${clip(String(sub.headline || 'see the deliverable').replace(/[.]+$/, ''), 120)}. Read the Assumptions section before you start.`, usage: { input: 0, output: 0 }, simulated: true } : await this.llm.complete({
          kind: 'handoff', maxTokens: 260, ...tk,
          system: this.personaSystem(author, 'You are handing your finished work to the next owner. Plain speech, 2 to 3 sentences, first person.'),
          user: `Your deliverable (${sub.skill}):\n${clip(deliverable.markdown, 2200)}\n\n${b.name}'s assignment (${ds.skill}): ${ds.instruction}\n\nWrite the handoff: the single most important finding for their work, any assumption you made that could change their approach, and the one thing you need back from them.`,
          ctx: { from: { short: author.short }, to: { short: b.short }, fromSkill: sub.skill, toSkill: ds.skill, headline: sub.headline, assumption },
        });
        if (!lean) { this.account(task, res); if (res.simulated) await this.sleepSim(0.6, tok); }
        this.talk(task, { from: author.id, to: b.id, kind: 'handoff', text: res.text });
        ds.handoff = clip(res.text, 600);
        if (this.collab === 'full') {
          // walk the note over in person
          const at = sim.nearestWalkable({ tx: Math.floor(b.x) + 1, ty: Math.floor(b.y) });
          const ok = await sim.goTo(author, { ...at, dir: 'left' }, { tok }); if (ok) { b.dir = b.pose === 'type' || b.pose === 'sit' ? b.dir : 'right'; sim.emoteFor(author, 'book', 3); sim.say(author, res.text, Math.min(8, 3 + res.text.length / 24)); await this.sleepSim(Math.min(5, 2 + res.text.length / 60), tok); }
        }
        b.memory.push({ t: Math.round(sim.time), text: `${author.short} handed off ${sub.skill}: ${clip(res.text, 90)}` });
      }
    }
    if (lead && lead.id !== author.id && !down.some((d) => d.agent === lead.id)) this.talk(task, { from: author.id, to: lead.id, kind: 'status', text: `${sub.skill} is done. ${sub.headline ? clip(sub.headline, 140) : ''}` });
    this.pushTask(task);
  },

  /** Two teammates who are free right now: if they share live work, they talk about it, with real status. */
  workChat(a, b) {
    const word = (s) => (s.status === 'working' ? 'in progress' : s.status === 'done' ? 'done' : 'queued behind its dependencies');
    for (const task of this.tasks.values()) {
      if (!['active', 'review'].includes(task.status)) continue;
      const sa = task.subtasks.find((s) => s.agent === a.id && s.status !== 'failed'), sb = task.subtasks.find((s) => s.agent === b.id && s.status !== 'failed');
      if (!sa || !sb || (sa.status === 'done' && sb.status === 'done')) continue;
      if (sa.deps.includes(sb.idx)) return { taskId: task.id, lines: [`${b.short}, where are you on the ${sb.skill}? I need it for my ${sa.skill}.`, sb.status === 'done' ? 'Finished. Check my handoff.' : sb.status === 'working' ? `In progress. You get the headline findings first.` : `Not started, I am ${sb.deps.length ? 'waiting on my inputs' : 'next in the queue'}.`] };
      if (sb.deps.includes(sa.idx)) return { taskId: task.id, lines: [`${b.short}, my ${sa.skill} is ${word(sa)}.${sa.status === 'done' ? ' Check the handoff.' : ' Headline findings first, I promise.'}`, `Thanks. I will start the ${sb.skill} the moment it lands.`] };
      return { taskId: task.id, lines: [`How is the ${sb.skill} going, ${b.short}?`, `${word(sb).replace(/^./, (c) => c.toUpperCase())}. Anything you need from me for the ${sa.skill}?`] };
    }
    return null;
  },

  // ------------------------------------------------------------ who reviews whom
  pickReviewer(author, sub) {
    const lead = this.leadOf(author.id);
    if (lead && lead.id !== 'vera' && lead.id !== author.id) return lead;           // first-line review by the team lead
    const expert = { copywriting: 'theo', 'copy-editing': 'theo', emails: 'theo', social: 'theo', analytics: 'dee', attribution: 'dee', 'ab-testing': 'dee', 'customer-research': 'sol', competitors: 'sol', 'competitor-profiling': 'sol', 'seo-audit': 'rafa', 'ai-seo': 'rafa', schema: 'rafa', ads: 'camila', 'ad-creative': 'zuri', pricing: 'indigo', offers: 'indigo' }[sub.skill];
    const e = expert && expert !== author.id ? this.agent(expert) : null;
    if (e) return e;
    return author.id === 'vera' ? this.agent('sol') : this.agent('vera');
  },

  // ------------------------------------------------------------ alignment: find real conflicts, decide, record
  async alignment(task, subs) {
    if (this.collab === 'off' || subs.length < 2) return;
    const vera = this.agent('vera'); const sim = this.sim;
    const digest = subs.map((s) => `### ${this.agent(s.agent).short} (${s.skill}, id ${s.agent})\n${clip(this.deliverables.get(s.outputId)?.markdown || '', 1100)}`).join('\n\n');
    const tk = this.toolkit(vera, task, { light: true });
    let conflicts = [];
    const res = await this.withAgent(vera, async (tok) => {
      sim.setStatus(vera, 'Checking the work fits together');
      return this.llm.complete({
        kind: 'align', maxTokens: 700, ...tk,
        system: this.personaSystem(vera, 'You are checking that the team\'s deliverables fit together before the summary goes to God.'),
        user: `${digest}\n\nFind REAL conflicts between these deliverables: incompatible recommendations, two people changing the same asset, inconsistent numbers or timelines, or one plan depending on something another plan is still changing. Do not invent conflicts, and do not list style differences.\nReply with JSON only: {"conflicts":[{"agents":["id","id"],"issue":"...","question":"..."}]} with at most 2 conflicts, or {"conflicts":[]}.`,
        ctx: { title: task.title, subs: subs.map((s) => ({ agent: s.agent, skill: s.skill })) },
      });
    });
    this.account(task, res);
    const j = extractJson(res.text); const ids = new Set(subs.map((s) => s.agent));
    conflicts = (Array.isArray(j?.conflicts) ? j.conflicts : []).filter((c) => Array.isArray(c.agents) && c.agents.length === 2 && c.agents.every((x) => ids.has(x)) && c.agents[0] !== c.agents[1] && c.issue).slice(0, 2);
    if (!conflicts.length) { this.talk(task, { from: 'vera', to: 'all', kind: 'status', text: 'I checked the deliverables against each other and found nothing that conflicts.' }); return; }
    for (const c of conflicts) {
      const A = this.agent(c.agents[0]), B = this.agent(c.agents[1]);
      const m = this.newMeeting(task, 'alignment', `Alignment: ${clip(c.issue, 60)}`, ['vera', A.id, B.id]); let free = [];
      try {
        await this.withAgent(vera, async (tok) => {
          sim.setStatus(vera, `Resolving: ${clip(c.issue, 40)}`);
          free = await this.seat(vera, [A, B], tok);
          await this.speak(task, m, vera, `${A.short} and ${B.short}: ${c.issue} ${c.question || ''}`.trim(), { kind: 'question', tok });
          const view = (x) => clip(this.deliverables.get(subs.find((s) => s.agent === x.id)?.outputId)?.markdown || '', 1200);
          let said = [];
          for (const [me, other, side] of this.collab === 'lean' ? [] : [[A, B, 0], [B, A, 1]]) {
            const tk2 = this.toolkit(me, task, { light: true });
            const r = await this.llm.complete({
              kind: 'align_reply', maxTokens: 260, ...tk2,
              system: this.personaSystem(me, 'You are in an alignment meeting. State your position and what you can compromise on, in 2 to 3 sentences. Be direct, not defensive.'),
              user: `The conflict: ${c.issue}\nThe question: ${c.question || ''}\n\nYour deliverable:\n${view(me)}\n\n${other.short}'s deliverable:\n${view(other)}\n${said.length ? `\n${other.short} just said: "${said[0]}"` : ''}`,
              ctx: { rule: c.rule, side, title: task.title },
            });
            this.account(task, r); if (r.simulated) await this.sleepSim(0.6, tok);
            said.push(r.text); me.dir = 'down'; await this.speak(task, m, me, r.text, { kind: 'question', to: other.id, tok });
          }
          const d = await this.llm.complete({
            kind: 'decision', maxTokens: 260, agent: vera.id,
            system: this.personaSystem(vera, 'You are the CMO making the call. State the decision, who owns it and by when, in 2 to 3 sentences. Pick one path, do not hedge.'),
            user: `The conflict: ${c.issue}\n${said.length ? `${A.short}: ${said[0]}\n${B.short}: ${said[1]}\n` : `${A.short} and ${B.short} have not been asked for their positions: decide from the deliverables.\n`}\nDecide.`, ctx: { rule: c.rule, title: task.title },
          });
          this.account(task, d); if (d.simulated) await this.sleepSim(0.6, tok);
          await this.speak(task, m, vera, d.text, { kind: 'decision', tok });
          const rec = { id: `${task.id}.D${(task.decisions?.length || 0) + 1}`, issue: c.issue, agents: [A.id, B.id], decision: clip(d.text, 500), by: 'vera' };
          (task.decisions ||= []).push(rec); m.summary = rec.decision;
          for (const x of [A, B]) { const sb = subs.find((s) => s.agent === x.id); if (sb) this.appendDecisionNote(task, sb, rec); x.memory.push({ t: Math.round(sim.time), text: `Decision: ${clip(rec.decision, 100)}` }); }
          this.learnFromDecision?.(task, rec, A, B, subs);
        });
      } finally { this.release(free); this.pushTask(task); }
    }
  },

  appendDecisionNote(task, sub, rec) {
    const d = this.deliverables.get(sub.outputId); if (!d) return;
    d.markdown = `${d.markdown.trimEnd()}\n\n## Decision after the alignment meeting\n${rec.decision}\n`;
    try { const dir = path.join(this.deliverablesDir, task.id); const f = fs.readdirSync(dir).find((x) => x.includes(`-${sub.agent}-${sub.skill}`)); if (f) fs.writeFileSync(path.join(dir, f), d.markdown); } catch { /* file copy is best-effort */ }
    this.emit('broadcast', { type: 'deliverable', deliverable: this.deliverableMeta(d) });
  },

  // ------------------------------------------------------------ escalation
  /** A workstream failed. Tell the lead; retry once; otherwise cut it with a note. Returns true if the retry succeeded. */
  async escalate(task, sub, err) {
    const a = this.agent(sub.agent); const lead = this.leadOf(a.id) || this.agent('vera'); const msg = String(err?.message || err);
    this.talk(task, { from: a.id, to: lead.id, kind: 'question', text: `I'm blocked on ${sub.skill}: ${clip(msg, 160)}. How do you want to handle it?` });
    this.addLog(`${a.name} escalated a failure on ${task.id} to ${lead.name}: ${msg}`, { type: 'system', agent: a.id, taskId: task.id });
    const retry = !sub.retried && this.collab !== 'off';
    const r = await this.llm.complete({ kind: 'escalate_reply', maxTokens: 160, ...this.toolkit(lead, task, { light: true }), system: this.personaSystem(lead, 'A teammate is blocked. Decide in 1 to 2 sentences: retry with a tighter scope, or proceed without it.'), user: `${a.name} failed at ${sub.skill} on "${task.title}": ${msg}`, ctx: { error: msg, retry } }).catch((e) => { if (e?.cancelled) throw e; return { text: retry ? 'Retry once with a tighter scope.' : 'Proceed without it.' }; });
    this.talk(task, { from: lead.id, to: a.id, kind: 'decision', text: r.text });
    if (!retry) { this.learnFromFailure?.(task, sub, msg); return false; }
    sub.retried = true; sub.status = 'ready'; sub.error = null;
    try { await this.runSubtask(task, sub); return true; }
    catch (e2) { if (e2?.cancelled) throw e2; // a stop is not a second failure
      this.talk(task, { from: 'vera', to: 'all', kind: 'decision', text: `${a.short}'s ${sub.skill} failed twice (${clip(String(e2.message || e2), 100)}). We proceed without it and flag the gap in the summary.` }); this.learnFromFailure?.(task, sub, String(e2.message || e2)); return false; }
  },

  // ------------------------------------------------------------ the toolbox every agent gets
  toolkit(a, task, { skill = null, light = false } = {}) {
    const tools = TOOL_DEFS.filter((t) => skill || t.name !== 'read_skill_reference');
    const extra = {}; const sim = this.sim; const state = { asks: 0, lessons: 0 };
    const log = (t) => { sim.say(a, t, 3); this.talk(task, { from: a.id, to: 'all', text: t, kind: 'research' }); };
    if (!light) {
      tools.push(ASK_TOOL); extra.ask_teammate = (inp) => this.askTeammate(a, task, inp, state);
      tools.push(REQUEST_TOOL); extra.request_info = (inp) => this.toolRequest(a, task, inp);
      if (this.hiringMode !== 'off') { tools.push(HIRE_TOOL); extra.request_hire = (inp) => this.toolHire(a, task, inp); }
      if (this.kb.mode === 'active') { tools.push(SAVE_TOOL, RECALL_TOOL); extra.save_lesson = (inp) => this.toolSaveLesson(a, task, inp, state); extra.recall_lessons = (inp) => this.toolRecall(a, task, inp); }
    }
    return { agent: a.id, tools, onTool: makeToolHandler({ skill, log, extra }), maxTurns: light ? 2 : 5 }; // agent: so the call uses this person's model
  },

  async askTeammate(a, task, { to, question }, state) {
    const key = String(to || '').toLowerCase().trim();
    const b = [...this.sim.agents.values()].find((x) => x.id === key || x.short.toLowerCase() === key || x.name.toLowerCase() === key);
    if (!b || b.id === a.id) return `No such teammate. Available: ${[...this.sim.agents.values()].filter((x) => x.id !== a.id).map((x) => `${x.id} (${x.role})`).join('; ')}.`;
    if (++state.asks > 3) return 'You have asked enough questions for this piece of work. Use what you have and state your assumptions.';
    const q = clip(String(question || ''), 500);
    this.talk(task, { from: a.id, to: b.id, kind: 'consult', text: q }); this.sim.say(a, q, 4);
    const tk = this.toolkit(b, task, { light: true });
    const r = await this.llm.complete({ kind: 'consult_a', maxTokens: 300, ...tk, system: this.personaSystem(b, `Answer ${a.name}'s question in at most 3 sentences with one concrete piece of advice from your craft.`), user: `${a.name} asks: ${q}\n\nTask: ${task.title}\n${this.contextText(task, 2500)}`, ctx: { title: task.title, to: b, from: a } });
    this.account(task, r);
    this.talk(task, { from: b.id, to: a.id, kind: 'consult', text: r.text }); this.sim.say(b, r.text, 5);
    a.stats.consults++; b.mood = Math.min(100, b.mood + 2);
    return r.text;
  },
};
