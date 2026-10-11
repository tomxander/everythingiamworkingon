// 4EVR the company: takes God's commands, plans the work, runs the agents,
// keeps the books. All the "business" lives here; the Sim only handles bodies.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { COMPANY, DEPT_META } from './roster.js';
import { bestSkill, skillPrompt } from './skills.js';
import { extractJson } from './llm.js';
import { planFromPlaybooks } from './mock.js';

const MAX_ACTIVE_TASKS = Number(process.env.MAX_ACTIVE_TASKS || 3);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const uniq = (arr) => [...new Set(arr)];

export class Company extends EventEmitter {
  constructor({ sim, llm, skills, dataDir, deliverablesDir }) {
    super();
    this.sim = sim; this.llm = llm; this.skills = skills;
    this.dataDir = dataDir; this.deliverablesDir = deliverablesDir;
    this.tasks = new Map(); this.deliverables = new Map();
    this.comms = []; this.log = [];
    this.seq = { task: 0, deliv: 0, msg: 0, log: 0 };
    this.skillUse = {};
    this.history = []; // sparkline samples
    this.budgetCap = Number(process.env.BUDGET_CAP_USD || 5);
    this.queue = []; this.active = 0;
    this.completed = 0;
    this.on('comms', (m) => this.addComms(m));
  }

  agent(id) { return this.sim.agents.get(id); }

  // ---------- plumbing ----------
  addComms(m) {
    const msg = { id: ++this.seq.msg, t: Number(this.sim.time.toFixed(1)), wall: Date.now(), ...m };
    this.comms.push(msg); if (this.comms.length > 600) this.comms.shift();
    this.emit('broadcast', { type: 'comms', msg });
    return msg;
  }
  addLog(text, extra = {}) {
    const e = { id: ++this.seq.log, t: Number(this.sim.time.toFixed(1)), wall: Date.now(), text, ...extra };
    this.log.push(e); if (this.log.length > 800) this.log.shift();
    this.emit('broadcast', { type: 'log', entry: e });
  }
  toast(text, level = 'info') { this.emit('broadcast', { type: 'toast', text, level }); }
  pushTask(task) { this.emit('broadcast', { type: 'task', task: this.publicTask(task) }); }

  publicTask(t) {
    return { ...t, subtasks: t.subtasks.map((s) => ({ ...s })) };
  }

  /** run `fn` while holding the agent: they stop what they were doing and queue behind their own work. */
  withAgent(a, fn) {
    const run = a.lock.then(async () => {
      a.busy = true;
      const tok = this.sim.claim(a);
      try { return await fn(tok); } finally { a.busy = false; a.pose = 'stand'; this.sim.setStatus(a, 'Available'); }
    });
    a.lock = run.catch(() => {});
    return run;
  }

  async sleepSim(sec, tok) { return this.sim.sleep(sec, tok); }

  guardBudget() {
    if (this.llm.mode === 'live' && this.llm.totals.cost >= this.budgetCap) {
      this.llm.setMode('mock');
      this.toast(`Budget cap of $${this.budgetCap.toFixed(2)} reached. Switched to simulation mode.`, 'warn');
      this.addLog(`Budget cap $${this.budgetCap.toFixed(2)} reached; switched to simulated mode.`, { type: 'system' });
    }
  }

  // ---------- God's commands ----------
  submitTask({ title, brief = '', priority = 'normal', assignee = null }) {
    title = clip((title || '').trim(), 140);
    if (!title) throw new Error('A task needs a title.');
    if (assignee && !this.agent(assignee)) throw new Error('Unknown assignee.');
    const id = `T${++this.seq.task}`;
    const task = {
      id, title, brief: clip((brief || '').trim(), 4000), priority, assignee,
      status: 'queued', created: Date.now(), simCreated: Number(this.sim.time.toFixed(1)),
      plan: null, subtasks: [], summaryId: null, tokens: 0, cost: 0, simulated: this.llm.mode === 'mock',
    };
    this.tasks.set(id, task);
    this.addComms({ from: 'god', to: assignee || 'vera', text: `${title}${brief ? ` — ${clip(brief, 200)}` : ''}`, kind: 'task', taskId: id });
    this.addLog(`God assigned ${id}: ${title}`, { type: 'task', taskId: id, agent: assignee || 'vera' });
    this.pushTask(task);
    this.queue.push(task); this.pump();
    return task;
  }

  pump() {
    while (this.active < MAX_ACTIVE_TASKS && this.queue.length) {
      const t = this.queue.shift(); this.active++;
      this.runTask(t).catch((e) => { console.error('task failed', e); t.status = 'failed'; t.error = String(e.message || e); this.pushTask(t); this.addLog(`${t.id} failed: ${t.error}`, { type: 'task', taskId: t.id }); })
        .finally(() => { this.active--; this.pump(); });
    }
  }

  retryTask(id) {
    const t = this.tasks.get(id); if (!t) throw new Error('No such task.');
    t.status = 'queued'; t.subtasks = []; t.plan = null; t.error = null; this.pushTask(t);
    this.queue.push(t); this.pump();
  }

  // ---------- the task pipeline ----------
  async runTask(task) {
    const vera = this.agent('vera');
    task.status = 'planning'; task.simulated = this.llm.mode === 'mock'; this.pushTask(task);
    this.guardBudget();

    let plan;
    if (task.assignee) {
      const a = this.agent(task.assignee);
      const skill = bestSkill(this.skills, a.skills, `${task.title} ${task.brief}`);
      plan = { summary: `Direct assignment to ${a.name}`, steps: [{ agent: a.id, skill, instruction: task.brief || task.title, deps: [], consult: null }] };
      this.addComms({ from: 'vera', to: a.id, text: `God asked for this directly, ${a.short}. It's yours. Use ${skill}.`, kind: 'task', taskId: task.id });
    } else {
      plan = await this.withAgent(vera, async (tok) => {
        this.sim.setStatus(vera, `Planning ${task.id}`);
        const spot = this.sim.map.spots.whiteboard_strategy;
        await this.sim.goTo(vera, { tx: spot.tx, ty: spot.ty, dir: 'up' }, { tok });
        vera.dir = 'up'; vera.pose = 'type'; this.sim.emoteFor(vera, 'bulb', 4);
        this.sim.say(vera, 'Let me think about who this needs…', 4);
        const p = await this.planTask(task, tok);
        return p;
      });
    }
    task.plan = { summary: plan.summary };
    task.subtasks = plan.steps.map((s, i) => ({
      id: `${task.id}.${i + 1}`, idx: i, agent: s.agent, skill: s.skill, instruction: s.instruction, deps: s.deps, consult: s.consult || null,
      status: 'waiting', outputId: null, started: null, ended: null, headline: null, review: null,
    }));
    task.status = 'active'; this.pushTask(task);
    const roster = uniq(task.subtasks.map((s) => this.agent(s.agent).name.split(' ')[0])).join(', ');
    this.addComms({ from: 'vera', to: 'all', text: `Plan for ${task.id}: ${plan.summary} ${task.subtasks.length} workstreams: ${roster}.`, kind: 'task', taskId: task.id });
    this.sim.say(vera, `${task.subtasks.length} workstreams. Go.`, 4);
    this.addLog(`Vera planned ${task.id} into ${task.subtasks.length} workstreams`, { type: 'task', taskId: task.id, agent: 'vera' });

    // run subtasks as their dependencies finish
    await new Promise((resolve) => {
      const started = new Set();
      const advance = () => {
        for (const s of task.subtasks) {
          if (started.has(s.id)) continue;
          const failedDep = s.deps.some((d) => task.subtasks[d]?.status === 'failed');
          if (failedDep) { s.status = 'failed'; started.add(s.id); continue; }
          if (s.deps.every((d) => task.subtasks[d]?.status === 'done')) {
            started.add(s.id); s.status = 'ready';
            this.runSubtask(task, s).catch((e) => { s.status = 'failed'; s.error = String(e.message || e); this.addLog(`${s.id} failed: ${s.error}`, { type: 'task', taskId: task.id, agent: s.agent }); })
              .finally(() => { this.pushTask(task); advance(); });
          }
        }
        if (task.subtasks.every((s) => s.status === 'done' || s.status === 'failed')) resolve();
      };
      advance();
    });

    const doneSubs = task.subtasks.filter((s) => s.status === 'done');
    if (!doneSubs.length) { task.status = 'failed'; task.error = task.error || 'All workstreams failed.'; this.pushTask(task); return; }

    // review & synthesis by Vera
    task.status = 'review'; this.pushTask(task);
    await this.synthesize(task, doneSubs);
    task.status = 'done'; task.finished = Date.now(); this.completed++;
    this.pushTask(task);
    this.addLog(`${task.id} complete: ${task.title}`, { type: 'task', taskId: task.id, agent: 'vera' });
    this.toast(`Task ${task.id} complete: ${task.title}`, 'good');
    await this.finale(task, doneSubs);
    this.save();
  }

  async planTask(task, tok) {
    const roster = [...this.sim.agents.values()].filter((a) => a.id !== 'vera' || true);
    const rosterText = roster.map((a) => `- ${a.id}: ${a.name}, ${a.role}. Skills: ${a.skills.join(', ')}`).join('\n');
    const system = [
      `${COMPANY.charter}\n\nYou are Vera Quill, CMO of 4EVR. Your job right now is to turn God's request into a plan of 3 to 7 workstreams, each owned by exactly one teammate and one of THEIR listed skills. Parallelise where possible; use "deps" (0-based indexes of earlier workstreams) only when the work truly needs another's output. Optionally set "consult" to a teammate id who should be asked for a quick opinion first. Do not assign final executive summary work; you will write that yourself.\n\nTeam:\n${rosterText}`,
    ];
    const user = `Request title: ${task.title}\n\nBrief:\n${task.brief || '(none beyond the title)'}\n\nReply with JSON only, in this shape:\n{"summary":"one sentence on the approach","steps":[{"agent":"id","skill":"skill-name","instruction":"what exactly they must produce","deps":[],"consult":null}]}`;
    let raw = null;
    try {
      const res = await this.llm.complete({ kind: 'plan', system, user, maxTokens: 1400, ctx: { title: task.title, brief: task.brief } });
      this.account(task, res);
      if (this.llm.mode === 'mock') await this.sleepSim(res.latencyMs / 1000, tok);
      raw = extractJson(res.text);
    } catch (e) {
      this.addLog(`Planner error (${e.message}); falling back to playbook`, { type: 'system' });
    }
    const plan = this.normalizePlan(raw) || planFromPlaybooks(task.title, task.brief);
    // make sure each chosen skill belongs to the agent (fallback to best match)
    for (const s of plan.steps) {
      const a = this.agent(s.agent);
      if (!a.skills.includes(s.skill) || !this.skills[s.skill]) s.skill = bestSkill(this.skills, a.skills, s.instruction || task.title);
    }
    return plan;
  }

  normalizePlan(raw) {
    if (!raw || !Array.isArray(raw.steps) || !raw.steps.length) return null;
    const steps = [];
    for (const s of raw.steps.slice(0, 8)) {
      if (!s || !this.agent(s.agent)) continue;
      steps.push({ agent: s.agent, skill: String(s.skill || ''), instruction: clip(String(s.instruction || 'Contribute your expertise.'), 500), deps: [], consult: this.agent(s.consult) && s.consult !== s.agent ? s.consult : null, _deps: Array.isArray(s.deps) ? s.deps : [] });
    }
    if (!steps.length) return null;
    steps.forEach((s, i) => { s.deps = uniq(s._deps.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d < i)); delete s._deps; });
    return { summary: clip(String(raw.summary || 'Coordinated multi-specialist plan.'), 220), steps };
  }

  account(task, res) {
    task.tokens += (res.usage?.input || 0) + (res.usage?.output || 0);
    const inT = res.usage?.input || 0, outT = res.usage?.output || 0;
    task.cost += (inT * this.llm.status().price.in + outT * this.llm.status().price.out) / 1e6;
    this.guardBudget();
  }

  async runSubtask(task, sub) {
    const a = this.agent(sub.agent); const sim = this.sim;
    const skill = this.skills[sub.skill];
    await this.withAgent(a, async (tok) => {
      sub.status = 'working'; sub.started = Date.now(); this.pushTask(task);
      sim.setStatus(a, `${sub.skill}: ${clip(task.title, 36)}`);
      this.addLog(`${a.name} started ${sub.skill} on ${task.id}`, { type: 'agent', agent: a.id, taskId: task.id });
      this.addComms({ from: a.id, to: 'all', text: `Starting ${sub.skill} for "${clip(task.title, 60)}".`, kind: 'task', taskId: task.id });

      if (sub.consult) { try { await this.consult(a, this.agent(sub.consult), task, sub, tok); } catch (e) { this.addLog(`Consult skipped (${e.message})`, { type: 'system', agent: a.id }); a.pose = 'stand'; } }

      await sim.goTo(a, a.desk.seat, { pose: 'sit', tok }); a.pose = 'type';
      sim.emoteFor(a, 'dots', 3);
      sim.say(a, `On it: ${sub.skill}`, 3.5);

      // upstream context
      const prior = sub.deps.map((d) => task.subtasks[d]).filter((s) => s?.outputId).map((s) => {
        const d = this.deliverables.get(s.outputId);
        return { agentName: this.agent(s.agent).name, agentShort: this.agent(s.agent).short, skill: s.skill, text: d.markdown, headline: s.headline || '' };
      });

      const system = [
        `${COMPANY.charter}\n\nYou are ${a.name}, ${a.role} at 4EVR. ${a.persona}${a.memory.length ? `\n\nThings you remember from recent work:\n${a.memory.slice(-6).map((m) => `- ${m.text}`).join('\n')}` : ''}`,
        skillPrompt(skill),
      ];
      const user = `## Client brief\nTitle: ${task.title}\n${task.brief || '(no further brief)'}\n\n## Your assignment (skill: ${sub.skill})\n${sub.instruction}\n\n## Upstream work from teammates\n${prior.length ? prior.map((p) => `### ${p.agentName} (${p.skill})\n${clip(p.text, 1800)}`).join('\n\n') : '(none; you are first in the chain)'}\n\n## Deliverable format\nMarkdown. Start with a "# " title. Include: Assumptions (bullets), the work product itself, ready to use, then "Next actions" and "How we'll know it worked". About 500 to 900 words unless the work needs more.`;

      this.guardBudget();
      const res = await this.llm.complete({
        kind: 'work', system, user, maxTokens: 2600,
        ctx: { title: task.title, brief: task.brief, agent: { id: a.id, name: a.name, short: a.short, role: a.role }, skill: skill && { name: skill.name, title: skill.title, body: skill.body }, instruction: sub.instruction, priorOutputs: prior },
      });
      if (this.llm.mode === 'mock' || res.simulated) await this.sleepSim(res.latencyMs / 1000, tok);
      this.account(task, res);

      const d = this.saveDeliverable(task, sub, a, res);
      sub.outputId = d.id; sub.headline = res.headline || headlineOf(res.text); sub.status = 'done'; sub.ended = Date.now();
      a.stats.tasks++; a.stats.deliverables++; a.stats.tokens += (res.usage?.input || 0) + (res.usage?.output || 0); a.stats.words += res.text.split(/\s+/).length;
      a.skillUse[sub.skill] = (a.skillUse[sub.skill] || 0) + 1; this.skillUse[sub.skill] = (this.skillUse[sub.skill] || 0) + 1;
      a.energy = Math.max(10, a.energy - 10); a.mood = Math.min(100, a.mood + 6);
      a.memory.push({ t: Math.round(sim.time), text: `Delivered ${sub.skill} work for "${clip(task.title, 50)}": ${clip(sub.headline || '', 80)}` });
      if (a.memory.length > 14) a.memory.shift();
      sim.emoteFor(a, 'star', 3); sim.say(a, 'Shipped.', 3);
      this.addComms({ from: a.id, to: 'all', text: `Delivered ${skill?.title || sub.skill}. ${sub.headline ? 'Headline: ' + clip(sub.headline, 140) : ''}`, kind: 'task', taskId: task.id });
      this.addLog(`${a.name} delivered ${sub.skill} for ${task.id}`, { type: 'deliverable', agent: a.id, taskId: task.id });
      this.pushTask(task);
      this.sim.addFx('sparkle', { agent: a.id }, 2.5);
      await this.sleepSim(1.2, tok);
    });
    // peer review (does not hold the author)
    await this.review(task, sub);
  }

  async consult(a, b, task, sub, tok) {
    const sim = this.sim; if (!b || b === a) return;
    sim.setStatus(a, `Asking ${b.short}`);
    const at = sim.nearestWalkable({ tx: Math.floor(b.x) + 1, ty: Math.floor(b.y) });
    const ok = await sim.goTo(a, { ...at, dir: 'left' }, { tok });
    if (!ok) return;
    const ctxQ = { title: task.title, to: { name: b.name, short: b.short, quirks: b.quirks }, from: a };
    const q = await this.llm.complete({ kind: 'consult_q', system: `You are ${a.name}, ${a.role}. ${a.persona} Ask ${b.name} (${b.role}) one short, specific question to sharpen your ${sub.skill} work. One or two sentences, no preamble.`, user: `Task: ${task.title}\n${task.brief}\nYour assignment: ${sub.instruction}`, maxTokens: 120, ctx: ctxQ });
    this.account(task, q); if (this.llm.mode === 'mock') await this.sleepSim(1.2, tok);
    a.pose = 'talk'; sim.say(a, q.text, 5.5); this.emit('comms', { from: a.id, to: b.id, text: q.text, kind: 'consult', taskId: task.id });
    b.dir = 'right';
    await this.sleepSim(4, tok);
    const ans = await this.llm.complete({ kind: 'consult_a', system: `You are ${b.name}, ${b.role}. ${b.persona} Answer ${a.name}'s question in two sentences max with one concrete piece of advice from your craft.`, user: `Question: ${q.text}\nTask: ${task.title}\n${task.brief}`, maxTokens: 160, ctx: { title: task.title, to: b, from: a } });
    this.account(task, ans);
    b.pose = 'talk'; a.pose = 'stand'; sim.say(b, ans.text, 5.5); this.emit('comms', { from: b.id, to: a.id, text: ans.text, kind: 'consult', taskId: task.id });
    a.stats.consults++; b.mood = Math.min(100, b.mood + 3);
    a.memory.push({ t: Math.round(sim.time), text: `${b.short} advised: ${clip(ans.text, 90)}` });
    await this.sleepSim(4, tok);
    b.pose = b.busy ? 'type' : 'stand';
  }

  async review(task, sub) {
    const reviewerId = ['vera', 'sol', 'dee', 'theo'].filter((id) => id !== sub.agent)[(sub.idx + task.simCreated) % 3];
    const r = this.agent(reviewerId); const author = this.agent(sub.agent);
    const d = this.deliverables.get(sub.outputId); if (!d) return;
    try {
      const res = await this.llm.complete({
        kind: 'review', maxTokens: 220,
        system: `You are ${r.name}, ${r.role} at 4EVR. ${r.persona} Give a two-sentence peer review of ${author.name}'s deliverable: one strength, one concrete improvement, then "Approved" or "Approved with notes".`,
        user: clip(d.markdown, 3500), ctx: { title: task.title, agent: r },
      });
      this.account(task, res);
      sub.review = { by: r.id, text: res.text };
      this.sim.say(r, `Reviewed ${author.short}'s work`, 3);
      this.emit('comms', { from: r.id, to: author.id, text: res.text, kind: 'review', taskId: task.id });
      author.mood = Math.min(100, author.mood + 3);
      r.memory.push({ t: Math.round(this.sim.time), text: `Reviewed ${author.short}'s ${sub.skill}` });
      this.pushTask(task);
    } catch (e) { /* review is best-effort */ }
  }

  async synthesize(task, subs) {
    const vera = this.agent('vera');
    const outputs = subs.map((s) => ({ agentName: this.agent(s.agent).name, skill: s.skill, headline: s.headline || '', text: this.deliverables.get(s.outputId)?.markdown || '' }));
    const text = await this.withAgent(vera, async (tok) => {
      this.sim.setStatus(vera, `Writing summary for ${task.id}`);
      await this.sim.goTo(vera, vera.desk.seat, { pose: 'sit', tok }); vera.pose = 'type';
      this.sim.say(vera, 'Pulling it together…', 4);
      const system = [`${COMPANY.charter}\n\nYou are Vera Quill, CMO of 4EVR. ${vera.persona}`, skillPrompt(this.skills['marketing-plan'], 6000)];
      const user = `Synthesize the team's work into an executive summary for God on: ${task.title}\n\nBrief:\n${task.brief || '(title only)'}\n\nTeam output:\n${outputs.map((o) => `## ${o.agentName} (${o.skill})\n${clip(o.text, 2200)}`).join('\n\n')}\n\nWrite: The call (3 sentences), What each specialist contributed (one line each), Risks and open decisions, Next 7 days, How we'll know it worked. Under 500 words.`;
      let res;
      try {
        res = await this.llm.complete({ kind: 'synth', system, user, maxTokens: 1800, ctx: { title: task.title, outputs } });
        if (res.simulated) await this.sleepSim(res.latencyMs / 1000, tok);
        this.account(task, res);
      } catch (e) {
        // never lose finished work because the summary call failed
        this.addLog(`Summary call failed (${e.message}); compiled a plain summary instead`, { type: 'system', agent: 'vera' });
        const text = `# Executive summary: ${task.title}\n\n> The summary model call failed (${e.message}). Below is a plain compilation of the team's headlines.\n\n${outputs.map((o) => `- **${o.agentName}** (${o.skill}): ${o.headline}`).join('\n')}`;
        res = { text, usage: { input: 0, output: 0 }, simulated: false };
      }
      return res;
    });
    const sub = { id: `${task.id}.S`, agent: 'vera', skill: 'marketing-plan', instruction: 'Executive summary' };
    const d = this.saveDeliverable(task, sub, vera, text, 'summary');
    task.summaryId = d.id;
    vera.stats.tasks++; vera.stats.tokens += (text.usage?.input || 0) + (text.usage?.output || 0);
    return d;
  }

  async finale(task, subs) {
    const sim = this.sim; const vera = this.agent('vera');
    const involved = uniq(subs.map((s) => s.agent)).filter((id) => id !== 'vera').map((id) => this.agent(id)).filter((a) => !a.busy && !a.ambientLock);
    const slots = sim.map.spots.townhall;
    involved.forEach((a) => { a.ambientLock = true; sim.claim(a); });
    await this.withAgent(vera, async (tok) => {
      sim.setStatus(vera, 'Presenting to the team');
      const walk = involved.map((a, i) => sim.goTo(a, { ...slots[(i * 2) % slots.length], dir: 'up' }, { tok: a.tok }));
      const pulpit = sim.map.spots.pulpit;
      await Promise.all([sim.goTo(vera, { ...pulpit, dir: 'down' }, { tok }), ...walk]);
      involved.forEach((a) => { a.dir = 'up'; a.pose = 'stand'; });
      vera.pose = 'talk'; vera.dir = 'down';
      sim.say(vera, `Done: ${clip(task.title, 70)}. Excellent work, everyone.`, 6);
      sim.addFx('confetti', { x: pulpit.x ?? pulpit.tx + 0.5, y: 12.2 }, 6);
      this.emit('comms', { from: 'vera', to: 'god', text: `${task.id} is complete: "${task.title}". The executive summary is in Output.`, kind: 'task', taskId: task.id });
      involved.forEach((a) => sim.emoteFor(a, 'heart', 4));
      await this.sleepSim(6, tok);
    });
    involved.forEach((a) => { a.ambientLock = false; });
  }

  saveDeliverable(task, sub, agent, res, kind = 'work') {
    const id = `D${++this.seq.deliv}`;
    const title = (res.text.match(/^#\s+(.+)$/m) || [null, `${sub.skill} for ${task.title}`])[1];
    const d = { id, taskId: task.id, subId: sub.id, agent: agent.id, skill: sub.skill, kind, title: clip(title, 140), markdown: res.text, created: Date.now(), tokens: (res.usage?.input || 0) + (res.usage?.output || 0), simulated: !!res.simulated };
    this.deliverables.set(id, d);
    try {
      const dir = path.join(this.deliverablesDir, task.id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${kind === 'summary' ? '00-summary' : sub.id.split('.').pop().padStart(2, '0') + '-' + agent.id + '-' + sub.skill}.md`), res.text);
    } catch (e) { console.error('could not write deliverable', e.message); }
    this.emit('broadcast', { type: 'deliverable', deliverable: this.deliverableMeta(d) });
    return d;
  }

  deliverableMeta(d) { const { markdown, ...rest } = d; return { ...rest, words: markdown.split(/\s+/).length, preview: clip(markdown.replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim(), 220) }; }

  // ---------- God's other powers ----------
  freeAgents() { return [...this.sim.agents.values()].filter((a) => !a.busy && !a.ambientLock); }

  async gather(agents, spotsFn, { pose = 'stand', hold = 6, onArrive } = {}) {
    const sim = this.sim; const list = agents;
    list.forEach((a) => { a.ambientLock = true; sim.claim(a); });
    await Promise.all(list.map((a, i) => sim.goTo(a, spotsFn(i), { pose, tok: a.tok })));
    if (onArrive) onArrive(list);
    await sim.sleep(hold, { agent: null });
    list.forEach((a) => { a.ambientLock = false; a.pose = 'stand'; });
  }

  announce(text) {
    text = clip(String(text || '').trim(), 280); if (!text) return;
    this.sim.addFx('godvoice', { text }, 7);
    this.addComms({ from: 'god', to: 'all', text, kind: 'announce' });
    this.addLog(`God announced: ${text}`, { type: 'system' });
    const slots = this.sim.map.spots.townhall;
    this.gather(this.freeAgents(), (i) => ({ ...slots[i % slots.length], dir: 'down' }), {
      hold: 7, onArrive: (list) => list.forEach((a, i) => { a.dir = 'down'; this.sim.emoteFor(a, 'exclaim', 3); if (i < 3) this.sim.say(a, ['Yes, God.', 'Listening!', 'Understood.'][i], 3.5); }),
    });
  }

  coffeeRound() {
    const c = this.sim.map.spots.coffee;
    this.addComms({ from: 'god', to: 'all', text: 'Coffee is on me. Everyone take five.', kind: 'announce' });
    this.addLog('God ordered a coffee round', { type: 'system' });
    this.sim.addFx('godvoice', { text: 'Coffee is on me.' }, 4);
    const free = this.freeAgents();
    this.gather(free, (i) => ({ tx: c.tx + ((i % 7) - 3), ty: c.ty + 1 + Math.floor(i / 7) * 1, dir: 'up' }), {
      pose: 'drink', hold: 7, onArrive: (list) => list.forEach((a) => { a.pose = 'drink'; a.dir = 'up'; this.sim.emoteFor(a, 'coffee', 5); a.mood = Math.min(100, a.mood + 15); a.energy = Math.min(100, a.energy + 30); }),
    });
  }

  townHall() {
    const slots = this.sim.map.spots.townhall;
    this.addComms({ from: 'god', to: 'all', text: 'Town Hall. Everyone, front and centre.', kind: 'announce' });
    this.sim.addFx('godvoice', { text: 'Town Hall. Front and centre.' }, 4);
    this.gather(this.freeAgents(), (i) => ({ ...slots[i % slots.length], dir: 'up' }), { hold: 9, onArrive: (l) => l.forEach((a) => { a.dir = 'up'; }) });
  }

  bless(id) { const a = this.agent(id); if (!a) return; a.mood = Math.min(100, a.mood + 25); a.energy = Math.min(100, a.energy + 40); this.sim.addFx('halo', { agent: id }, 4); this.sim.emoteFor(a, 'heart', 4); this.sim.say(a, 'I feel… renewed!', 3.5); this.addLog(`God blessed ${a.name}`, { type: 'system', agent: id }); }
  smite(id) { const a = this.agent(id); if (!a) return; a.mood = Math.max(0, a.mood - 12); this.sim.addFx('lightning', { agent: id }, 1.4); this.sim.say(a, 'Why me?!', 3.5); this.sim.emoteFor(a, 'exclaim', 3); this.addLog(`God smote ${a.name} (lightly)`, { type: 'system', agent: id }); }

  async godChat(id, text) {
    const a = this.agent(id); if (!a) throw new Error('Unknown agent.');
    text = clip(String(text || '').trim(), 600); if (!text) return;
    this.addComms({ from: 'god', to: id, text, kind: 'dm' });
    this.sim.emoteFor(a, 'exclaim', 2);
    const current = a.status || 'idle';
    const res = await this.llm.complete({
      kind: 'chat', maxTokens: 300,
      system: `${COMPANY.charter}\n\nYou are ${a.name}, ${a.role} at 4EVR. ${a.persona}\nYour skills: ${a.skills.join(', ')}. You are currently: ${current}. Recent memory:\n${a.memory.slice(-5).map((m) => `- ${m.text}`).join('\n') || '- (nothing yet)'}\nReply to God in 1 to 3 sentences, in character. If asked for work, tell God to assign it as a task.`,
      user: text, ctx: { agent: a, title: text },
    });
    this.llm.status(); this.guardBudget();
    this.sim.say(a, res.text, 7);
    this.addComms({ from: id, to: 'god', text: res.text, kind: 'dm' });
    return res.text;
  }

  // ---------- metrics ----------
  sampleHistory() {
    const t = this.llm.totals;
    this.history.push({ t: Math.round(this.sim.time), done: this.completed, delivs: this.deliverables.size, tokens: t.inputTokens + t.outputTokens, cost: Number(t.cost.toFixed(4)) });
    if (this.history.length > 240) this.history.shift();
  }

  stats() {
    const agents = [...this.sim.agents.values()];
    const depts = {};
    for (const a of agents) {
      const d = (depts[a.dept] ||= { ...DEPT_META[a.dept], tasks: 0, deliverables: 0, mood: 0, energy: 0, n: 0, working: 0 });
      d.tasks += a.stats.tasks; d.deliverables += a.stats.deliverables; d.mood += a.mood; d.energy += a.energy; d.n++; if (a.busy) d.working++;
    }
    for (const d of Object.values(depts)) { d.mood = Math.round(d.mood / d.n); d.energy = Math.round(d.energy / d.n); }
    const byStatus = {}; for (const t of this.tasks.values()) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    return {
      llm: this.llm.status(), budgetCap: this.budgetCap, completed: this.completed, tasks: this.tasks.size, byStatus, deliverables: this.deliverables.size,
      depts, skillUse: this.skillUse, history: this.history,
      morale: Math.round(agents.reduce((s, a) => s + a.mood, 0) / agents.length), energy: Math.round(agents.reduce((s, a) => s + a.energy, 0) / agents.length),
      active: this.active, queued: this.queue.length,
      agents: agents.map((a) => ({ id: a.id, stats: a.stats, memory: a.memory.slice(-8), skillUse: a.skillUse })),
    };
  }

  // ---------- persistence ----------
  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const agents = {}; for (const a of this.sim.agents.values()) agents[a.id] = { stats: a.stats, memory: a.memory, skillUse: a.skillUse, mood: a.mood, energy: a.energy };
      const data = {
        v: 1, savedAt: Date.now(), seq: this.seq, completed: this.completed, simTime: this.sim.time, skillUse: this.skillUse, history: this.history,
        tasks: [...this.tasks.values()], deliverables: [...this.deliverables.values()], comms: this.comms.slice(-300), log: this.log.slice(-400), agents,
        llmTotals: this.llm.totals, budgetCap: this.budgetCap,
      };
      const tmp = path.join(this.dataDir, 'state.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, path.join(this.dataDir, 'state.json'));
    } catch (e) { console.error('save failed', e.message); }
  }

  load() {
    const file = path.join(this.dataDir, 'state.json');
    if (!fs.existsSync(file)) return false;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.seq = { ...this.seq, ...d.seq }; this.completed = d.completed || 0; this.sim.time = d.simTime || 0;
      this.skillUse = d.skillUse || {}; this.history = d.history || [];
      for (const t of d.tasks || []) {
        if (['planning', 'active', 'review', 'queued'].includes(t.status)) { t.status = 'interrupted'; t.error = 'Server restarted while this was running. Use Retry.'; t.subtasks.forEach((s) => { if (s.status === 'working' || s.status === 'ready') s.status = 'waiting'; }); }
        this.tasks.set(t.id, t);
      }
      for (const x of d.deliverables || []) this.deliverables.set(x.id, x);
      this.comms = d.comms || []; this.log = d.log || [];
      for (const [id, st] of Object.entries(d.agents || {})) { const a = this.agent(id); if (a) { a.stats = { ...a.stats, ...st.stats }; a.memory = st.memory || []; a.skillUse = st.skillUse || {}; a.mood = st.mood ?? a.mood; a.energy = st.energy ?? a.energy; } }
      if (d.llmTotals) Object.assign(this.llm.totals, d.llmTotals, { simulated: this.llm.mode === 'mock' });
      if (d.budgetCap) this.budgetCap = d.budgetCap;
      return true;
    } catch (e) { console.error('could not load state', e.message); return false; }
  }
}

function headlineOf(md) {
  const lines = md.split('\n');
  let inAssump = false;
  for (const l of lines) {
    if (/^#{2,3}\s+/.test(l)) { inAssump = /assumption/i.test(l); continue; }
    if (inAssump) continue;
    const m = l.match(/^\s*(?:[-*]|\d+\.)\s+(.{20,})$/);
    if (m) return clip(m[1].replace(/[*`_]/g, ''), 140);
  }
  return clip((md.replace(/^#.*$/gm, '').replace(/[*`_>#]/g, '').replace(/\s+/g, ' ').trim()), 140);
}
