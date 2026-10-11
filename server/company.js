// 4EVR the company: takes God's commands, plans the work, runs the agents,
// keeps the books. All the "business" lives here; the Sim only handles bodies.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { COMPANY, DEPT_META } from './roster.js';
import { bestSkill, skillPrompt, rankSkills } from './skills.js';
import { extractJson } from './llm.js';
import { planFromPlaybooks, heuristicIntake } from './mock.js';
import { crawlSite, extractUrls, siteFindings, snapshotToText, TOOL_DEFS, makeToolHandler, webSearch } from './tools.js';
import { Knowledge } from './knowledge.js';
import { collab } from './collab.js';
import { hiring } from './hiring.js';
import { learning } from './learning.js';
import { hr } from './hr.js';
import { inbox } from './inbox.js';

const MAX_ACTIVE_TASKS = Number(process.env.MAX_ACTIVE_TASKS || 3);
const CLIENT_TTL = 6 * 3600 * 1000; // re-read a client's site after 6 hours
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const uniq = (arr) => [...new Set(arr)];

export class Company extends EventEmitter {
  constructor({ sim, llm, skills, dataDir, deliverablesDir }) {
    super();
    this.sim = sim; this.llm = llm; this.skills = skills;
    this.dataDir = dataDir; this.deliverablesDir = deliverablesDir;
    this.tasks = new Map(); this.deliverables = new Map();
    this.comms = []; this.log = [];
    this.seq = { task: 0, deliv: 0, msg: 0, log: 0, hire: 0, hireReq: 0 };
    this.skillUse = {};
    this.clients = new Map(); // host -> { host, url, fetchedAt, snapshot, profile }
    this.kb = new Knowledge(dataDir);                      // what the company has learned
    this.collab = process.env.COLLAB || 'full';            // full | lean | off: how much the team talks (and how many model calls that costs)
    this.hiringMode = process.env.HIRING || 'auto';        // auto | ask | off
    this.hiringCaps = { headcount: Number(process.env.HIRE_MAX_HEADCOUNT || 24), total: Number(process.env.HIRE_LIMIT || 12), perTask: Number(process.env.HIRE_PER_TASK || 3) };
    this.hires = new Map(); this.hireRequests = new Map(); this.schedulers = new Map();
    this.webResearch = process.env.WEB_RESEARCH !== 'off';  // simulated mode also does real web searches
    this.life = null; this.skillSyncs = [];
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
  /** A problem the person watching should see on the task itself, not only in the Log tab. */
  warn(task, text) {
    (task.warnings ||= []).push(clip(text, 300)); if (task.warnings.length > 6) task.warnings.shift();
    this.addLog(text, { type: 'system', taskId: task.id }); this.toast(clip(text, 140), 'warn'); this.pushTask(task);
  }
  pushTask(task) { this.emit('broadcast', { type: 'task', task: this.publicTask(task) }); }

  publicTask(t) {
    const { thread, ...rest } = t; // the shared channel is for the agents; the UI gets meetings and decisions
    return { ...rest, subtasks: t.subtasks.map((s) => ({ ...s })) };
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
    if (this.llm.mode !== 'mock' && this.llm.totals.cost >= this.budgetCap) {
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
    // start clean: nothing from the failed run (warnings, meetings, decisions, discussion, consult counts) should leak into the retry
    Object.assign(t, { status: 'queued', subtasks: [], plan: null, error: null, warnings: [], meetings: [], decisions: [], thread: [], expertConsults: 0, summaryId: null, intake: null, retried: (t.retried || 0) + 1 });
    this.pushTask(t);
    this.queue.push(t); this.pump();
  }

  // ---------- the task pipeline ----------
  async runTask(task) {
    const vera = this.agent('vera');
    task.status = 'planning'; task.simulated = this.llm.mode === 'mock'; this.pushTask(task);
    this.guardBudget();

    // 1. Research: if the request names a website, actually read it before anyone plans anything.
    task.urls = extractUrls(`${task.title}\n${task.brief}`);
    if (task.urls.length) await this.recon(task);

    let plan;
    if (task.assignee) {
      const a = this.agent(task.assignee);
      task.intake = heuristicIntake(task.title, task.brief, this.primarySnapshot(task));
      const skill = bestSkill(this.skills, a.skills, `${task.title} ${task.brief}`);
      plan = { summary: `Direct assignment to ${a.name}`, steps: [{ agent: a.id, skill, instruction: task.brief || task.title, deps: [], consult: null }] };
      this.addComms({ from: 'vera', to: a.id, text: `God asked for this directly, ${a.short}. It's yours. Use ${skill}.`, kind: 'task', taskId: task.id });
    } else {
      plan = await this.withAgent(vera, async (tok) => {
        this.sim.setStatus(vera, `Planning ${task.id}`);
        const spot = this.sim.map.spots.whiteboard_strategy;
        await this.sim.goTo(vera, { tx: spot.tx, ty: spot.ty, dir: 'up' }, { tok });
        vera.dir = 'up'; vera.pose = 'type'; this.sim.emoteFor(vera, 'bulb', 4);
        this.sim.say(vera, 'Turning that into a proper brief…', 4);
        // 2. Intake: a one-line instruction becomes an objective, a metric, assumptions and open questions.
        task.intake = await this.makeIntake(task, tok);
        this.raiseIntakeQuestions(task);
        this.pushTask(task);
        this.addComms({ from: 'vera', to: 'all', kind: 'task', taskId: task.id, text: `Intake for ${task.id}: ${task.intake.objective}. Metric: ${task.intake.metric}. Target: ${task.intake.target}. ${task.intake.openQuestions.length} open question(s) logged for God; proceeding on stated assumptions.` });
        this.sim.say(vera, 'Who does this need?', 3);
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
    const roster = uniq(task.subtasks.map((s) => this.agent(s.agent).short)).join(', ');
    this.addComms({ from: 'vera', to: 'all', text: `Plan for ${task.id}: ${plan.summary} ${task.subtasks.length} workstreams: ${roster}.`, kind: 'task', taskId: task.id });
    this.sim.say(vera, `${task.subtasks.length} workstreams. Go.`, 4);
    this.addLog(`Vera planned ${task.id} into ${task.subtasks.length} workstreams`, { type: 'task', taskId: task.id, agent: 'vera' });

    // 3. Kickoff: the owners are briefed together and say what they need from each other
    await this.kickoff(task).catch((e) => this.addLog(`Kickoff skipped (${e.message})`, { type: 'system', taskId: task.id }));

    // run subtasks as their dependencies finish
    await new Promise((resolve) => {
      const started = new Set();
      const advance = () => {
        for (const s of task.subtasks) {
          if (started.has(s.id)) continue;
          const failedDep = s.deps.some((d) => task.subtasks[d]?.status === 'failed');
          if (failedDep) { s.status = 'failed'; s.error = `Skipped because a workstream it builds on failed (${task.subtasks[s.deps.find((d) => task.subtasks[d]?.status === 'failed')]?.skill || 'upstream'}).`; started.add(s.id); continue; }
          if (s.deps.every((d) => task.subtasks[d]?.status === 'done')) {
            started.add(s.id); s.status = 'ready';
            this.runSubtask(task, s).catch(async (e) => {
              // a failure goes to the lead first; one retry; otherwise the workstream is cut and the gap is flagged
              const recovered = await this.escalate(task, s, e).catch(() => false);
              if (!recovered) { s.status = 'failed'; s.error = String(e.message || e); this.addLog(`${s.id} failed: ${s.error}`, { type: 'task', taskId: task.id, agent: s.agent }); }
            }).finally(() => { this.pushTask(task); advance(); });
          }
        }
        if (task.subtasks.every((s) => s.status === 'done' || s.status === 'failed')) resolve();
      };
      this.schedulers.set(task.id, advance); // lets someone hired mid-task add a workstream
      advance();
    });
    this.schedulers.delete(task.id);

    const doneSubs = task.subtasks.filter((s) => s.status === 'done');
    if (!doneSubs.length) {
      // say WHY: the most common error, and (for real models) a connection test that separates a bad key, a bad model or an old CLI from a one-off failure
      const errs = task.subtasks.map((s) => s.error).filter((e) => e && !/^Skipped/.test(e)); const top = [...new Set(errs)].sort((a, b) => errs.filter((x) => x === b).length - errs.filter((x) => x === a).length)[0];
      let diag = ''; if (this.llm.mode !== 'mock') { const r = await this.llm.test(); diag = r.ok ? `\nA connection test just now succeeded (${r.text}), so this looks like a one-off. Press Retry.` : `\nConnection test: ${r.error}`; }
      task.status = 'failed'; task.error = task.error || `All workstreams failed.${top ? `\nMost common error: ${top}` : ''}${diag}`; this.pushTask(task); this.addLog(`${task.id} failed: ${clip(task.error, 200)}`, { type: 'task', taskId: task.id }); return;
    }

    // review & synthesis by Vera
    task.status = 'review'; this.pushTask(task);
    // 4. Alignment: look for real conflicts between the deliverables and decide them before the summary
    await this.alignment(task, doneSubs).catch((e) => this.addLog(`Alignment skipped (${e.message})`, { type: 'system', taskId: task.id }));
    await this.synthesize(task, doneSubs);
    task.status = 'done'; task.finished = Date.now(); this.completed++;
    this.pushTask(task);
    this.addLog(`${task.id} complete: ${task.title}`, { type: 'task', taskId: task.id, agent: 'vera' });
    this.toast(`Task ${task.id} complete: ${task.title}`, 'good');
    await this.finale(task, doneSubs);
    // 5. Retrospective: what worked, what did not, what changes. This is where the company learns.
    await this.retro(task, doneSubs).catch((e) => this.addLog(`Retro skipped (${e.message})`, { type: 'system', taskId: task.id }));
    await this.hrAfterTask().catch((e) => this.addLog(`People review skipped (${e.message})`, { type: 'system' }));
    this.save();
  }

  async planTask(task, tok) {
    await this.refreshSkills('planning'); // the planner should see the newest playbooks
    const roster = [...this.sim.agents.values()].filter((a) => a.id !== 'vera' || true);
    const gaps = this.skillGaps('marketing').map((k) => `${k} (${this.skills[k].summary})`);
    const rosterText = roster.map((a) => `- ${a.id}: ${a.name}, ${a.role}. Skills: ${a.skills.join(', ')}.${a.domains?.length ? ` Domain expertise: ${a.domains.join(', ')}.` : ''}${a.hired ? ' (hired earlier: use them before hiring anyone new)' : ''}${a.dept === 'people' ? ' (People & Talent: assign only HR, hiring, workforce or employer-branding work)' : ''}`).join('\n') + `\n\n${this.hrSnapshotText()}`;
    const system = [
      `${COMPANY.charter}\n\nYou are Vera Quill, CMO of 4EVR. Your job right now is to turn God's request into a plan of 3 to 7 workstreams, each owned by exactly one teammate and one of THEIR listed skills. Parallelise where possible; use "deps" (0-based indexes of earlier workstreams) only when the work truly needs another's output. Optionally set "consult" to a teammate id who should be asked for a quick opinion first. Do not assign final executive summary work; you will write that yourself.\n\nTeam:\n${rosterText}`,
    ];
    const user = `Request title: ${task.title}\n\nBrief:\n${task.brief || '(none beyond the title)'}\n\n${this.contextText(task, 6000)}\n\nPlanning rules:\n- Tailor every workstream to the evidence above. Name the real pages, offers and gaps.\n- Nobody on the team can log in to ad accounts, analytics, a CRM or the client's CMS, or change the live site. Plan recommendations and ready-to-use assets, not actions inside those systems.\n- Match the goal type (${task.intake?.goalType || 'unknown'}): for inbound leads from a website plan conversion, SEO, copy, lead capture and nurture, paid and tracking. Use outbound or cold email only if the request asks for it.\n- Always include one workstream that makes the result measurable.${this.hiringMode === 'off' ? '' : `\n- Hiring: if the work needs domain expertise or capacity nobody on the team has (for example an industry specialist), you may hire. Add it to "hires" and assign a step to it with "agent":"hire:0" (its index in "hires"). Hire only when no current teammate can do the job well. Skills must come from the skills library${gaps.length ? `. These library skills are not owned by anyone on the team yet, so hire for them if the work needs them: ${gaps.slice(0, 12).join('; ')}` : ''}.`}\n\nReply with JSON only, in this shape:\n{"summary":"one sentence on the approach","hires":[{"role":"job title","skills":["skill-name"],"why":"why nobody here can do it","domain":"optional one word"}],"steps":[{"agent":"id","skill":"skill-name","instruction":"what exactly they must produce","deps":[],"consult":null}]}`;
    let raw = null;
    try {
      const res = await this.llm.complete({ kind: 'plan', system, user, maxTokens: 1600, timeoutMs: Number(process.env.PLAN_TIMEOUT_S || 150) * 1000, ...this.toolkit(this.agent('vera'), task, { light: true }), ctx: { title: task.title, brief: task.brief, intake: task.intake } });
      this.account(task, res);
      if (this.llm.mode === 'mock') await this.sleepSim(res.latencyMs / 1000, tok);
      raw = extractJson(res.text);
      if (!res.simulated && !raw) this.warn(task, 'The planner did not return a usable plan, so the workstreams come from the built-in playbook for this kind of request.');
    } catch (e) {
      this.warn(task, `Planning failed (${e.message}). The workstreams come from the built-in playbook for this kind of request.`);
    }
    const plan = this.normalizePlan(raw) || planFromPlaybooks(task.title, task.brief, 7, task.intake?.playbook);
    await this.applyHires(task, plan, raw?.hires); // new people are hired before anyone starts, so the kickoff includes them
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
      if (!s || !(this.agent(s.agent) || /^hire:\d+$/.test(s.agent || ''))) continue;
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

      // a planned consult, or by default a word with whoever produced the work you are building on
      const consultWith = sub.consult || (this.collab === 'full' && sub.deps.length ? task.subtasks[sub.deps[0]]?.agent : null) || this.pickExpert(a, task, sub)?.id;
      if (consultWith && consultWith !== a.id) { try { await this.consult(a, this.agent(consultWith), task, sub, tok); } catch (e) { this.addLog(`Consult skipped (${e.message})`, { type: 'system', agent: a.id }); a.pose = 'stand'; } }

      await sim.goTo(a, a.desk.seat, { pose: 'sit', tok }); a.pose = 'type';
      sim.emoteFor(a, 'dots', 3);
      sim.say(a, `On it: ${sub.skill}`, 3.5);

      // upstream context
      const prior = sub.deps.map((d) => task.subtasks[d]).filter((s) => s?.outputId).map((s) => {
        const d = this.deliverables.get(s.outputId);
        return { agentName: this.agent(s.agent).name, agentShort: this.agent(s.agent).short, skill: s.skill, text: d.markdown, headline: s.headline || '' };
      });

      const kbb = this.kbBlock(a, task, skill, sub.instruction); sub.lessonIds = kbb.ids; sub.hadLessons = kbb.ids.length > 0;
      const system = this.workSystem(a, task, skill, kbb.text);
      const thread = this.threadText(task, a.id);
      const user = `## Client request\nTitle: ${task.title}\n${task.brief || '(no further brief)'}\n\n## Who owns what on this task (stay in your lane; build on theirs, do not repeat it)\n${this.planBoard(task, sub)}\n\n## Your assignment (skill: ${sub.skill})\n${sub.instruction}\n\n## Upstream work from teammates\n${prior.length ? prior.map((p) => `### ${p.agentName} (${p.skill})\n${clip(p.text, 1800)}`).join('\n\n') : '(none; you are first in the chain)'}${thread ? `\n\n## Team discussion so far (read it, and answer anything addressed to you)\n${thread}` : ''}\n\n## Rules for this deliverable\n- Ground every statement about the client in the client context above and cite the page URL. Label anything you could not verify as "Not verified".\n- You cannot log in to or change the client's systems. Give recommendations and ready-to-use assets (copy, specs, configurations) and say who should apply them.\n- Do not ask questions. State assumptions and proceed.\n\n## Deliverable format\nMarkdown. Start with a "# " title. Include: Assumptions (bullets), the work product itself, ready to use, then "Next actions" and "How we'll know it worked". About 500 to 900 words unless the work needs more.`;

      this.guardBudget();
      const web = this.llm.mode === 'mock' ? await this.mockWebResearch(task, a, skill) : null; // simulated mode still really searches the web
      const res = await this.llm.complete({
        kind: 'work', system, user, maxTokens: 3500, ...this.toolkit(a, task, { skill }),
        ctx: { web, lessons: kbb.ids.map((id) => this.kb.lessons.get(id)?.text).filter(Boolean).slice(0, 5), thread: (task.thread || []).filter((m) => (m.to === a.id || m.kind === 'decision' || (m.kind === 'kickoff' && m.from !== a.id)) && m.kind !== 'review').slice(-4), title: task.title, brief: task.brief, intake: task.intake, snapshot: this.primarySnapshot(task), agent: { id: a.id, name: a.name, short: a.short, role: a.role }, skill: skill && { name: skill.name, title: skill.title, body: skill.body }, instruction: sub.instruction, priorOutputs: prior },
      });
      if (res.truncated) this.addLog(`${a.name}'s ${sub.skill} output hit the length limit even after continuing`, { type: 'system', agent: a.id });
      if (this.llm.mode === 'mock' || res.simulated) await this.sleepSim(res.latencyMs / 1000, tok);
      this.account(task, res);

      const d = this.saveDeliverable(task, sub, a, res);
      if (res.simulated) this.mockDataNeeds(task, a, sub);
      sub.outputId = d.id; sub.headline = res.headline || headlineOf(res.text); sub.status = 'done'; sub.ended = Date.now();
      a.stats.tasks++; a.stats.deliverables++; a.stats.tokens += (res.usage?.input || 0) + (res.usage?.output || 0); a.stats.words += res.text.split(/\s+/).length;
      a.skillUse[sub.skill] = (a.skillUse[sub.skill] || 0) + 1; this.skillUse[sub.skill] = (this.skillUse[sub.skill] || 0) + 1;
      a.energy = Math.max(10, a.energy - 10); a.mood = Math.min(100, a.mood + 6);
      a.memory.push({ t: Math.round(sim.time), text: `Delivered ${sub.skill} work for "${clip(task.title, 50)}": ${clip(sub.headline || '', 80)}` });
      if (a.memory.length > 14) a.memory.shift();
      sim.emoteFor(a, 'star', 3); sim.say(a, 'Shipped.', 3);
      await this.handoffs(task, sub, a, d, tok).catch((e) => this.addLog(`Handoff skipped (${e.message})`, { type: 'system', agent: a.id }));
      this.addComms({ from: a.id, to: 'all', text: `Delivered ${skill?.title || sub.skill}. ${sub.headline ? 'Headline: ' + clip(sub.headline, 140) : ''}`, kind: 'task', taskId: task.id });
      this.addLog(`${a.name} delivered ${sub.skill} for ${task.id}`, { type: 'deliverable', agent: a.id, taskId: task.id });
      this.pushTask(task);
      this.sim.addFx('sparkle', { agent: a.id }, 2.5);
      await this.sleepSim(1.2, tok);
    });
    // peer review (does not hold the author)
    await this.review(task, sub);
  }

  planBoard(task, sub) {
    return task.subtasks.map((x) => `- ${this.agent(x.agent)?.short || x.agent}: ${x.skill} (${x.status})${x.id === sub.id ? ' <- you' : ''}${x.deps.length ? `, builds on ${x.deps.map((d) => this.agent(task.subtasks[d]?.agent)?.short).filter(Boolean).join(', ')}` : ''}`).join('\n');
  }

  /**
   * A workstream with nobody upstream still gets outside input: the best-fit teammate who is not on this task
   * (so specialists such as research, offers or content are not left out), if they are free and the task has budget for it.
   */
  pickExpert(a, task, sub) {
    if (this.collab !== 'full' || (task.expertConsults || 0) >= 3) return null;
    const onTask = new Set(task.subtasks.map((s) => s.agent)); const text = `${sub.skill.replace(/-/g, ' ')} ${sub.instruction} ${task.title}`;
    let best = null;
    for (const c of this.sim.agents.values()) {
      if (c.id === a.id || onTask.has(c.id) || c.dept === 'people' || c.busy || this.load_of(c.id) >= 3) continue;
      const own = Object.fromEntries(c.skills.filter((k) => this.skills[k]).map((k) => [k, this.skills[k]]));
      const top = rankSkills(own, text, 1, this.skills)[0]; if (!top || top.score < 4) continue;
      if (!best || top.score > best.score) best = { agent: c, score: top.score };
    }
    if (best) task.expertConsults = (task.expertConsults || 0) + 1;
    return best?.agent || null;
  }

  async consult(a, b, task, sub, tok) {
    const sim = this.sim; if (!b || b === a) return;
    sim.setStatus(a, `Asking ${b.short}`);
    const at = sim.nearestWalkable({ tx: Math.floor(b.x) + 1, ty: Math.floor(b.y) });
    const ok = await sim.goTo(a, { ...at, dir: 'left' }, { tok });
    if (!ok) return;
    const ctxQ = { title: task.title, to: { name: b.name, short: b.short, quirks: b.quirks }, from: a };
    const q = await this.llm.complete({ kind: 'consult_q', ...this.toolkit(a, task, { light: true }), system: `You are ${a.name}, ${a.role}. ${a.persona} Ask ${b.name} (${b.role}) one short, specific question to sharpen your ${sub.skill} work. One or two sentences, no preamble.`, user: `Task: ${task.title}\n${task.brief}\nYour assignment: ${sub.instruction}`, maxTokens: 120, ctx: ctxQ });
    this.account(task, q); if (this.llm.mode === 'mock') await this.sleepSim(1.2, tok);
    a.pose = 'talk'; sim.say(a, q.text, 5.5); this.talk(task, { from: a.id, to: b.id, text: q.text, kind: 'consult' });
    b.dir = 'right';
    await this.sleepSim(4, tok);
    const ans = await this.llm.complete({ kind: 'consult_a', ...this.toolkit(b, task, { light: true }), system: `You are ${b.name}, ${b.role}. ${b.persona} Answer ${a.name}'s question in two sentences max with one concrete piece of advice from your craft.`, user: `Question: ${q.text}\nTask: ${task.title}\n${task.brief}`, maxTokens: 160, ctx: { title: task.title, to: b, from: a } });
    this.account(task, ans);
    b.pose = 'talk'; a.pose = 'stand'; sim.say(b, ans.text, 5.5); this.talk(task, { from: b.id, to: a.id, text: ans.text, kind: 'consult' });
    a.stats.consults++; b.mood = Math.min(100, b.mood + 3);
    a.memory.push({ t: Math.round(sim.time), text: `${b.short} advised: ${clip(ans.text, 90)}` });
    await this.sleepSim(4, tok);
    b.pose = b.busy ? 'type' : 'stand';
  }

  async review(task, sub) {
    const author = this.agent(sub.agent); const r = this.pickReviewer(author, sub); // the team lead reviews first, then a cross-functional expert
    const d = this.deliverables.get(sub.outputId); if (!d) return;
    try {
      const res = await this.llm.complete({
        kind: 'review', maxTokens: 400, ...this.toolkit(r, task, { light: true }),
        system: `You are ${r.name}, ${r.role} at 4EVR. ${r.persona}\nYou are doing a peer review of ${author.name}'s deliverable. Judge it against the client context. Be strict about three things: claims about the client that are not backed by the context (or labelled Not verified), generic advice that could apply to any company, and actions that would need access we do not have.\nReply with JSON only: {"verdict":"approve" or "revise","strength":"one sentence","improvement":"one concrete sentence"}. Use "revise" only for a real problem, not style.\n\n${this.contextText(task, 3500)}`,
        user: clip(d.markdown, 5000), ctx: { title: task.title, agent: r, markdown: d.markdown },
      });
      this.account(task, res);
      const j = extractJson(res.text);
      const verdict = j?.verdict === 'revise' ? 'revise' : 'approve';
      const text = j ? `${j.strength || ''} ${j.improvement || ''} (${verdict === 'revise' ? 'Needs revision' : 'Approved'})`.trim() : res.text;
      sub.review = { by: r.id, text, verdict, strength: j?.strength || null, improvement: j?.improvement || null };
      this.sim.say(r, `Reviewed ${author.short}'s work`, 3);
      this.talk(task, { from: r.id, to: author.id, text, kind: 'review' });
      author.mood = Math.min(100, author.mood + 3);
      r.memory.push({ t: Math.round(this.sim.time), text: `Reviewed ${author.short}'s ${sub.skill}` });
      this.pushTask(task);
      await this.afterReview(task, sub, author, sub.review); // credit or blame the lessons that were in the prompt, and learn from the feedback
      if (verdict === 'revise' && !res.simulated && !sub.revised) await this.revise(task, sub, j.improvement || text);
    } catch (e) { /* review is best-effort */ }
  }

  /** One revision pass when a reviewer found a real problem. */
  async revise(task, sub, feedback) {
    const a = this.agent(sub.agent); const skill = this.skills[sub.skill]; const d = this.deliverables.get(sub.outputId);
    sub.revised = true;
    await this.withAgent(a, async (tok) => {
      this.sim.setStatus(a, `Revising ${sub.skill}`);
      await this.sim.goTo(a, a.desk.seat, { pose: 'sit', tok }); a.pose = 'type'; this.sim.say(a, 'Fixing the review notes…', 3);
      this.addComms({ from: a.id, to: sub.review?.by || 'all', text: `Revising after review: ${clip(feedback, 160)}`, kind: 'task', taskId: task.id });
      const res = await this.llm.complete({
        kind: 'revise', maxTokens: 3500, system: this.workSystem(a, task, skill), ...this.toolkit(a, task, { skill }),
        user: `Here is your deliverable and a reviewer's finding. Fix the finding and return the complete improved deliverable in the same format. Do not shrink it, and do not mention the review inside the deliverable.\n\n## Reviewer finding\n${feedback}\n\n## Your deliverable\n${d.markdown}`,
        ctx: { title: task.title },
      });
      this.account(task, res);
      if (res.text.length > d.markdown.length * 0.5) {
        d.markdown = res.text; d.revised = true;
        try { fs.writeFileSync(path.join(this.deliverablesDir, task.id, fs.readdirSync(path.join(this.deliverablesDir, task.id)).find((f) => f.includes(`-${sub.agent}-${sub.skill}`)) || `${sub.id}.md`), res.text); } catch { /* file copy is best-effort */ }
        this.emit('broadcast', { type: 'deliverable', deliverable: this.deliverableMeta(d) });
        sub.headline = headlineOf(res.text);
      }
    });
    this.pushTask(task);
  }

  async synthesize(task, subs) {
    const vera = this.agent('vera');
    const outputs = subs.map((s) => ({ agentName: this.agent(s.agent).name, skill: s.skill, headline: s.headline || '', text: this.deliverables.get(s.outputId)?.markdown || '' }));
    const text = await this.withAgent(vera, async (tok) => {
      this.sim.setStatus(vera, `Writing summary for ${task.id}`);
      await this.sim.goTo(vera, vera.desk.seat, { pose: 'sit', tok }); vera.pose = 'type';
      this.sim.say(vera, 'Pulling it together…', 4);
      const system = [`${COMPANY.charter}\n\nYou are Vera Quill, CMO of 4EVR. ${vera.persona}`, skillPrompt(this.skills['marketing-plan'], 6000)];
      const user = `Synthesize the team's work into an executive summary for God on: ${task.title}\n\nBrief:\n${task.brief || '(title only)'}\n\n${this.contextText(task, 3000)}${(task.decisions || []).length ? `\n\n## Decisions made in alignment meetings\n${task.decisions.map((d) => `- ${d.issue} DECISION: ${d.decision}`).join('\n')}` : ''}${(task.hires || []).length ? `\n\n## People hired for this task\n${task.hires.map((id) => { const h = this.agent(id); return h ? `- ${h.name}, ${h.role}: ${h.why || ''}` : ''; }).join('\n')}` : ''}\n\nTeam output:\n${outputs.map((o) => `## ${o.agentName} (${o.skill})\n${clip(o.text, 2200)}`).join('\n\n')}\n\nWrite: The call (3 sentences), What each specialist contributed (one line each), Open questions for God (use the intake open questions that still matter), Risks and open decisions, Next 7 days, How we'll know it worked. Anything the team could not verify must be stated as such. Under 600 words.`;
      let res;
      try {
        res = await this.llm.complete({ kind: 'synth', system, user, maxTokens: 2200, ...this.toolkit(vera, task, { light: true }), ctx: { title: task.title, outputs, intake: task.intake, decisions: task.decisions } });
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

  // ---------- research, intake and shared context ----------
  primarySnapshot(task) {
    const host = task.sources?.[0]?.host; return host ? this.clients.get(host)?.snapshot || null : null;
  }

  /** Text block every agent receives: the structured brief plus what we actually saw on the client's site. */
  contextText(task, max = 8000) {
    const parts = [];
    const i = task.intake;
    if (i) parts.push(`## Intake brief\nObjective: ${i.objective}\nGoal type: ${i.goalType}\nPrimary metric: ${i.metric}\nTarget: ${i.target}\nTimeframe: ${i.timeframe}\nBudget: ${i.budget}\nAudience: ${i.audience}\n${i.constraints?.length ? `Constraints:\n${i.constraints.map((x) => `- ${x}`).join('\n')}\n` : ''}Assumptions:\n${(i.assumptions || []).map((x) => `- ${x}`).join('\n')}\nOpen questions (unanswered, so treat as assumptions):\n${(i.openQuestions || []).map((x) => `- ${x}`).join('\n') || '- none'}`);
    const host = task.sources?.[0]?.host; const entry = host && this.clients.get(host);
    if (entry?.profile) parts.push(`## Client profile (evidence-based, from the client's own site)\n${entry.profile}`);
    for (const src of task.sources || []) {
      parts.push(`## Sources read for ${src.host}\n${src.pages.map((p) => `- ${p.url}${p.title ? ` (${p.title})` : ''}`).join('\n') || '- none'}${src.errors.length ? `\nCould not read: ${src.errors.map((e) => `${e.url} (${e.error})`).join('; ')}` : ''}`);
    }
    const asked = this.requestsText(task); if (asked) parts.push(asked);
    if (task.urls?.length && !(task.sources || []).some((x) => x.pages.length)) parts.push(`## IMPORTANT\nThe request names ${task.urls.join(', ')} but the site could not be read. Nothing about it is verified. Do not invent facts about the company; label everything about it "Not verified".`);
    return clip(parts.join('\n\n') || '## Client context\n(No website or structured context available. Work only from the request and mark assumptions.)', max);
  }

  workSystem(a, task, skill, kbText = '') {
    return [
      `${COMPANY.charter}\n\nYou are ${a.name}, ${a.role} at 4EVR${a.reportsTo ? `, reporting to ${this.agent(a.reportsTo)?.name || 'the CMO'}` : ''}. ${a.persona}${a.memory.length ? `\n\nThings you remember from recent work:\n${a.memory.slice(-6).map((m) => `- ${m.text}`).join('\n')}` : ''}${kbText ? `\n\n${kbText}` : ''}\n\n# Client context (shared by the whole team)\n${this.contextText(task, 9000)}`,
      skillPrompt(skill),
    ];
  }

  /** Sol reads the client's site(s) for real. Nothing downstream may claim to know the site otherwise. */
  async recon(task) {
    const sol = this.agent('sol'); const sim = this.sim;
    task.status = 'researching'; task.sources = []; this.pushTask(task);
    let profileText = null;
    await this.withAgent(sol, async (tok) => {
      for (const [i, url] of task.urls.entries()) {
        const host = new URL(url).hostname.replace(/^www\./, '');
        sim.setStatus(sol, `Reading ${host}`);
        await sim.goTo(sol, sim.map.spots.vault[0], { tok }); sol.pose = 'type'; sim.emoteFor(sol, 'magnifier', 4); sim.say(sol, `Reading ${host}…`, 4);
        let entry = this.clients.get(host); let cached = false;
        if (entry && Date.now() - entry.fetchedAt < CLIENT_TTL && entry.snapshot.pages.length) cached = true;
        else {
          const snapshot = await crawlSite(url, { maxPages: i === 0 ? 6 : 2 });
          entry = { host, url, fetchedAt: Date.now(), snapshot, profile: null };
          if (snapshot.pages.length) this.clients.set(host, entry);
        }
        const snap = entry.snapshot; const findings = siteFindings(snap);
        if (i === 0 && !entry.external && this.outsideResearch !== false && (this.webResearch || this.llm.mode !== 'mock')) { sim.say(sol, `Looking beyond ${host}…`, 4); entry.external = await this.externalResearch(task, sol, host, snap); this.clients.set(host, entry); }
        task.sources.push({ host, url, cached, pages: snap.pages.map((p) => ({ url: p.url, title: p.title, words: p.words })), errors: snap.errors, findings });
        if (!snap.pages.length) {
          const why = snap.errors?.[0]?.error || 'unknown error';
          this.emit('comms', { from: 'sol', to: 'all', kind: 'task', taskId: task.id, text: `I could not open ${host}: ${why}. Everything about the site will be marked Not verified.` });
          this.toast(`Could not read ${host}: ${why}`, 'warn'); this.addLog(`Could not read ${host}: ${why}`, { type: 'system', agent: 'sol', taskId: task.id });
          continue;
        }
        this.emit('comms', { from: 'sol', to: 'all', kind: 'task', taskId: task.id, text: `Read ${snap.pages.length} page(s) of ${host}${cached ? ' (from cache)' : ''}. ${findings.length} observation(s), for example: ${clip(findings[0] || 'none', 120)}` });
        if (i === 0 && !entry.profile) {
          const skill = this.skills['product-marketing'];
          const res = await this.llm.complete({
            kind: 'profile', maxTokens: 2500, ...this.toolkit(sol, task, { light: true }),
            system: [`${COMPANY.charter}\n\nYou are ${sol.name}, ${sol.role}. ${sol.persona}`, skillPrompt(skill, 9000)],
            user: `Build the client profile for ${host} using ONLY the evidence below plus the request. Follow the structure of the product-marketing context document (overview, audience, offer and positioning, proof, conversion path, tracking, competitors if visible, brand voice). Cite page URLs. Put everything you cannot see from outside (traffic, conversion rate, lead quality, sales process, budget, ICP details) under a "Not verified" heading instead of guessing.\n\nRequest: ${task.title}\n${task.brief}\n\n# Evidence read from the site\n${snapshotToText(snap, { perPage: 2500, total: 16000 })}${externalToText(entry.external)}`,
            ctx: { title: task.title, brief: task.brief, snapshot: { ...snap, external: entry.external } },
          });
          if (res.simulated) await this.sleepSim(Math.min(6, res.latencyMs / 1000), tok);
          this.account(task, res);
          entry.profile = res.text; this.clients.set(host, entry);
          const d = this.saveDeliverable(task, { id: `${task.id}.R`, skill: 'product-marketing' }, sol, res, 'profile');
          task.profileId = d.id;
        }
        if (i === 0) profileText = entry.profile;
      }
      sol.energy = Math.max(10, sol.energy - 8);
    });
    void profileText;
    task.status = 'planning'; this.pushTask(task);
  }

  /**
   * The client's own site is one source. Search the wider internet for what others say about them: news, reviews,
   * competitors, background and forum talk. If searches worked but found nothing, that gap goes to God's tracker.
   */
  async externalResearch(task, sol, host, snap) {
    const brand = host.split('.')[0]; const queries = [
      { source: 'news', q: brand }, { source: 'web', q: `${host} reviews` }, { source: 'web', q: `${brand} competitors alternatives` },
      { source: 'wiki', q: brand }, { source: 'reddit', q: `${brand} ${host}` },
    ];
    const out = []; let ok = 0, found = 0;
    for (const { source, q } of queries) {
      try { const results = await webSearch(q, { source, max: 4 }); ok++; found += results.length; out.push({ source, q, results }); this.talk(task, { from: sol.id, to: 'all', kind: 'research', text: `Searched ${source === 'web' ? 'the web' : source} for "${clip(q, 50)}": ${results.length} result(s)` }); }
      catch (e) { out.push({ source, q, results: [], error: clip(e.message, 120) }); }
    }
    const ext = { at: Date.now(), queries: out, found, searchesOk: ok };
    if (ok > 0 && found === 0) this.raiseRequest(task, sol, { kind: 'question', what: `Who are ${host}'s main competitors, and what do their customers say about them? Public search found nothing about them outside their own site.`, why: 'Positioning and competitor work need outside evidence.', tried: `Searched news, web, wiki and forums for "${brand}" and "${host}": no results.`, origin: 'research' });
    else if (ok === 0) this.addLog(`Outside search was unavailable for ${host}: ${out[0]?.error || 'unknown'}`, { type: 'system', agent: sol.id, taskId: task.id });
    return ext;
  }

  /** Vera turns a vague instruction into an objective, metric, assumptions and open questions. */
  async makeIntake(task, tok) {
    const vera = this.agent('vera');
    const fallback = heuristicIntake(task.title, task.brief, this.primarySnapshot(task) || (task.urls?.length ? { host: task.sources?.[0]?.host, pages: [], errors: task.sources?.[0]?.errors || [] } : null));
    const system = [`${COMPANY.charter}\n\nYou are ${vera.name}, ${vera.role}. ${vera.persona}\nYou are writing the intake brief that the whole team will work from. Be concrete, do not invent facts, and separate what is known from what is assumed.`];
    const user = `Request title: ${task.title}\n\nBrief:\n${task.brief || '(none)'}\n\n${this.contextText(task, 7000).replace(/^## Intake brief[\s\S]*?(?=\n## |$)/, '')}\n\nReply with JSON only:\n{"objective":"one clear sentence","goalType":"one of leadgen|outbound|seo|paid|launch|lifecycle|cro|pricing|pr|social|strategy","metric":"the one primary metric","target":"a number and unit if given, else 'Not specified'","timeframe":"...","budget":"...","audience":"who we are trying to reach","constraints":["..."],"assumptions":["each assumption we are making because information is missing"],"openQuestions":["at most 4 questions whose answers would most change the work"]}\nIf the request says a website should get more leads, the goalType is leadgen (inbound), not outbound.`;
    try {
      const deadline = Number(process.env.INTAKE_TIMEOUT_S || 120) * 1000;
      let res = await this.llm.complete({ kind: 'intake', system, user, maxTokens: 1200, timeoutMs: deadline, ...this.toolkit(vera, task, { light: true }), ctx: { title: task.title, brief: task.brief, intake: fallback } });
      this.account(task, res); if (res.simulated) await this.sleepSim(2.5, tok);
      let j = res.simulated ? fallback : extractJson(res.text);
      if (!res.simulated && (!j || !j.objective)) { // the model answered in prose (often after searching): ask once more, plainly, with no tools
        this.addLog('The intake answer was not usable JSON; asking again without tools', { type: 'system', taskId: task.id });
        res = await this.llm.complete({ kind: 'intake', system, user: `${user}\n\nReply with the JSON object only. No prose, no markdown fences.`, maxTokens: 1200, timeoutMs: deadline, ctx: { title: task.title, brief: task.brief, intake: fallback } });
        this.account(task, res); j = extractJson(res.text);
      }
      if (!j || !j.objective) { this.warn(task, 'Vera could not produce a usable intake brief for this request, so the brief below is a generic fallback. The workstreams are still planned from the request itself.'); return fallback; }
      const goals = ['leadgen', 'outbound', 'seo', 'paid', 'launch', 'lifecycle', 'cro', 'pricing', 'pr', 'social', 'strategy'];
      const goalType = goals.includes(j.goalType) ? j.goalType : fallback.goalType;
      const toPlaybook = { outbound: 'sales' };
      const arr = (v, d) => (Array.isArray(v) ? v.map((x) => clip(String(x), 240)).slice(0, 8) : d);
      return {
        objective: clip(String(j.objective), 300), goalType, playbook: toPlaybook[goalType] || goalType, metric: clip(String(j.metric || fallback.metric), 160), target: clip(String(j.target || 'Not specified'), 120),
        timeframe: clip(String(j.timeframe || fallback.timeframe), 80), budget: clip(String(j.budget || 'Not specified'), 80), audience: clip(String(j.audience || fallback.audience), 240),
        constraints: arr(j.constraints, []), assumptions: arr(j.assumptions, fallback.assumptions), openQuestions: arr(j.openQuestions, fallback.openQuestions).slice(0, 4), site: fallback.site,
      };
    } catch (e) {
      this.warn(task, `The intake call failed (${e.message}). The brief below is a generic fallback, not tailored to this request.`);
      return fallback;
    }
  }

  /** Simulated mode cannot reason about the web, but it can still really search it and show what came back. */
  async mockWebResearch(task, a, skill) {
    if (!this.webResearch) return null;
    const topic = (task.intake?.objective || task.title).replace(/^(make|get)\s+\S+\s+/i, '').slice(0, 70);
    const query = `${skill?.title || 'marketing'} ${topic}`.slice(0, 120);
    try { const results = await webSearch(query, { max: 3 }); this.talk(task, { from: a.id, to: 'all', kind: 'research', text: `Searched the web: "${clip(query, 70)}" (${results.length} results)` }); return { query, results }; }
    catch (e) { return { query, error: e.message }; }
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
      kind: 'chat', maxTokens: 300, ...this.toolkit(a, null, { light: true }),
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
      depts, skillUse: this.skillUse, history: this.history, learning: this.kb.summary(), hiring: this.hiringStatus(), collab: this.collab,
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
      this.kb.save();
      const data = {
        v: 1, savedAt: Date.now(), seq: this.seq, completed: this.completed, simTime: this.sim.time, skillUse: this.skillUse, history: this.history,
        tasks: [...this.tasks.values()], deliverables: [...this.deliverables.values()], comms: this.comms.slice(-300), log: this.log.slice(-400), agents,
        llmTotals: this.llm.totals, budgetCap: this.budgetCap, clients: [...this.clients.values()], hires: [...this.hires.values()], settings: { collab: this.collab, hiringMode: this.hiringMode }, hr: this.hrSave(), inbox: this.inboxSave(),
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
      for (const h of d.hires || []) { if (!this.sim.agents.has(h.id) && this.sim.map.desks[h.room]?.[h.slot]) { this.sim.addAgent(h); this.hires.set(h.id, h); } }
      if (d.settings?.collab && !process.env.COLLAB) this.collab = d.settings.collab;
      if (d.settings?.hiringMode && !process.env.HIRING) this.hiringMode = d.settings.hiringMode;
      this.kb.load(); this.hrLoad(d.hr); this.inboxLoad(d.inbox);
      for (const t of d.tasks || []) {
        if (['planning', 'active', 'review', 'queued'].includes(t.status)) { t.status = 'interrupted'; t.error = 'Server restarted while this was running. Use Retry.'; t.subtasks.forEach((s) => { if (s.status === 'working' || s.status === 'ready') s.status = 'waiting'; }); }
        this.tasks.set(t.id, t);
      }
      for (const x of d.deliverables || []) this.deliverables.set(x.id, x);
      this.comms = d.comms || []; this.log = d.log || [];
      for (const [id, st] of Object.entries(d.agents || {})) { const a = this.agent(id); if (a) { a.stats = { ...a.stats, ...st.stats }; a.memory = st.memory || []; a.skillUse = st.skillUse || {}; a.mood = st.mood ?? a.mood; a.energy = st.energy ?? a.energy; } }
      if (d.llmTotals) Object.assign(this.llm.totals, d.llmTotals, { simulated: this.llm.mode === 'mock' });
      if (d.budgetCap) this.budgetCap = d.budgetCap;
      for (const c of d.clients || []) this.clients.set(c.host, c);
      return true;
    } catch (e) { console.error('could not load state', e.message); return false; }
  }
}

function externalToText(ext) {
  if (!ext) return '';
  const body = ext.queries.filter((x) => x.results.length).map((x) => `## ${x.source}: "${x.q}"\n${x.results.map((r) => `- ${r.title} (${r.url}) ${r.snippet}`).join('\n')}`).join('\n\n');
  return `\n\n# Evidence from outside the site (search snippets only: treat as leads to check, not verified facts)\n${body || (ext.searchesOk ? '(searches ran and found nothing about this company outside its own site)' : '(outside search was unavailable)')}`;
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

Object.assign(Company.prototype, collab, hiring, learning, hr, inbox);
