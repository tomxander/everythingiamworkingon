// The tracker: agents ask God for the questions, documents and data they cannot find themselves.
// Requests never block the work. The agent carries on with labelled assumptions; when God answers, the answer
// reaches every later workstream, and "apply answers" sends the affected deliverables back for a revision.
import { DATA_NEEDS } from './mock.js';
import { extractJson } from './llm.js';

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const KINDS = ['question', 'document', 'data', 'access'];
const PER_TASK = 8, PER_AGENT = 3, MAX_ANSWER = 60000;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3);
const similar = (a, b) => { const A = new Set(norm(a)), B = new Set(norm(b)); if (!A.size || !B.size) return false; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size) >= 0.6; };

export const REQUEST_TOOL = {
  name: 'request_info',
  description: 'Ask God (the founder) for something you need and could not find: a question only they can answer, a document, a data export, or access. Search the wider internet first (web, news, wiki, reddit) and use any connected tools; only ask when that failed, and say what you tried. This does not stop your work: carry on with clearly labelled assumptions. God\'s answer is added to the task for the teammates who work after you.',
  input_schema: { type: 'object', properties: {
    kind: { type: 'string', enum: KINDS, description: 'question, document, data (an export or numbers) or access (a login or permission).' },
    what: { type: 'string', description: 'Exactly what you need, specific enough that God can supply it in one go.' },
    why: { type: 'string', description: 'What you cannot do well without it.' },
    tried: { type: 'string', description: 'What you already searched or checked, and what you found.' },
  }, required: ['kind', 'what', 'why', 'tried'] },
};

export const inbox = {
  inboxState() { return (this.requests ||= new Map()); },

  /** Create a request unless the same thing was already asked on this task. Returns { req, duplicate } or { error }. */
  raiseRequest(task, agent, { kind, what, why = '', tried = '', origin = 'agent', subId = null }) {
    const reqs = this.inboxState(); what = clip(String(what || '').trim(), 400);
    if (what.length < 8) return { error: 'Say specifically what you need.' };
    kind = KINDS.includes(kind) ? kind : 'question';
    const mine = [...reqs.values()].filter((r) => r.taskId === (task?.id || null));
    const dup = mine.find((r) => similar(r.what, what)); if (dup) return { req: dup, duplicate: true };
    if (mine.length >= PER_TASK) return { error: `This task already has ${PER_TASK} requests open. Work with what you have.` };
    if (mine.filter((r) => r.by === agent.id).length >= PER_AGENT) return { error: `You have already made ${PER_AGENT} requests on this task.` };
    const seq = (this.seq.request = (this.seq.request || 0) + 1);
    const req = { id: `Q${seq}`, taskId: task?.id || null, taskTitle: task?.title || null, subId, by: agent.id, kind, what, why: clip(why, 300), tried: clip(tried, 300), origin, status: 'open', created: Date.now(), answer: null, appliedAt: null };
    reqs.set(req.id, req);
    this.talk(task, { from: agent.id, to: 'god', kind: 'question', text: `${kind === 'question' ? 'Question' : `I need a ${kind}`} for you: ${what}${why ? ` (${clip(why, 120)})` : ''}` });
    this.sim.say(agent, 'Need an input from God', 3);
    this.addLog(`${agent.name} asked God: ${clip(what, 90)}`, { type: 'agent', agent: agent.id, taskId: task?.id });
    this.emit('broadcast', { type: 'request', request: req });
    this.toast(`${agent.short} needs something from you: ${clip(what, 70)}`, 'warn');
    this.tryResolve?.(req).catch(() => {}); // when a Claude account with connectors is attached, try to fetch it from there first
    return { req };
  },

  /**
   * With a Claude account attached and connectors switched on, look for the thing in the connected tools first
   * (documents, notes, CRM, analytics). Read-only. If it is found the request is answered, marked with where it came from.
   */
  async tryResolve(req) {
    if (!this.llm.cliConnectorsOn() || req.status !== 'open') return false;
    const task = this.tasks.get(req.taskId); this.addLog(`Looking in connected tools for: ${clip(req.what, 80)}`, { type: 'system', agent: req.by, taskId: req.taskId });
    let res;
    try {
      res = await this.llm.complete({ kind: 'resolve', maxTokens: 1500, tools: [], onTool: async () => '', maxTurns: 4,
        system: `You are a research assistant at 4EVR with read-only access to the founder's connected tools (notes, documents, CRM, analytics, files) and web search. Find the specific item requested. Quote the data or document text itself, not a description of it. Reply with JSON only: {"found":true or false,"answer":"the content, at most 4000 characters","source":"which connected tool and item it came from"}. If you cannot find it, say found=false. Never guess and never invent.`,
        user: `Request: ${req.what}\nWhy it is needed: ${req.why}\nTask: ${task?.title || ''}\nBrief: ${task?.brief || ''}` });
    } catch (e) { this.addLog(`Connected-tools lookup failed: ${e.message}`, { type: 'system', agent: req.by }); return false; }
    if (task) this.account(task, res);
    const j = extractJson(res.text);
    if (req.status !== 'open' || !j?.found || String(j.answer || '').trim().length < 20) return false;
    req.status = 'answered'; req.answer = { text: clip(String(j.answer), MAX_ANSWER), files: [], by: `connector: ${clip(String(j.source || 'connected tools'), 60)}`, at: Date.now() }; req.auto = true;
    this.talk(task || null, { from: req.by, to: 'all', kind: 'decision', text: `Found what I asked for in ${req.answer.by.replace('connector: ', '')}: ${clip(req.what, 80)}. You can overrule it in the tracker.` });
    this.emit('broadcast', { type: 'request', request: req }); this.save();
    return true;
  },

  /** Tool for live agents. */
  async toolRequest(a, task, input) {
    if (String(input.tried || '').trim().length < 10) return 'Before asking God, search the wider internet (web, news, wiki, reddit) and use any connected tools, then call request_info again and say in "tried" what you searched and what you found.';
    const r = this.raiseRequest(task, a, { kind: input.kind, what: input.what, why: input.why, tried: input.tried });
    if (r.error) return r.error;
    if (r.duplicate) return `Already requested as ${r.req.id} (${r.req.status}). ${r.req.answer ? `Answer: ${clip(r.req.answer.text, 600)}` : 'Carry on with labelled assumptions.'}`;
    return `Logged as ${r.req.id}. God answers asynchronously, so do not wait: continue now, state your assumption for this item, and write it in "Next actions" so the answer can be applied later.`;
  },

  /** What was really looked at before asking: mention the client's site only when pages from it were read. */
  triedSoFar(task, base) {
    const host = (task.sources || []).find((x) => x.pages?.length)?.host;
    return host ? `${base} and read ${host}` : base;
  },

  /** Simulated mode: each playbook has the data it would really want. Raised once per task, unless the brief already supplies it. */
  mockDataNeeds(task, a, sub) {
    const need = DATA_NEEDS[sub.skill]; if (!need) return;
    const [kind, what, why, hint] = need;
    if (hint && new RegExp(hint, 'i').test(`${task.title} ${task.brief || ''}`)) return;
    if ([...this.inboxState().values()].filter((r) => r.taskId === task.id && r.origin === 'agent').length >= 3) return;
    this.raiseRequest(task, a, { kind, what, why, tried: `${this.triedSoFar(task, 'Searched the web')}; this is not public.`, subId: sub.id });
  },

  /** The open questions from intake become requests, so they are tracked instead of buried in a summary. */
  raiseIntakeQuestions(task) {
    const vera = this.agent('vera');
    for (const q of (task.intake?.openQuestions || []).slice(0, 3)) this.raiseRequest(task, vera, { kind: 'question', what: q, why: 'Raised during intake.', tried: `${this.triedSoFar(task, 'Read the brief')}.`, origin: 'intake' });
  },

  answerRequest(id, { text = '', files = [], decline = false } = {}) {
    const r = this.inboxState().get(id); if (!r) throw new Error('No such request.');
    if (decline) { r.status = 'declined'; r.answer = { text: 'God cannot provide this. Carry on with labelled assumptions.', files: [], by: 'god', at: Date.now() }; }
    else {
      const fs = (Array.isArray(files) ? files : []).slice(0, 5).map((f) => ({ name: clip(String(f.name || 'file'), 80), text: clip(String(f.text || ''), 30000) })).filter((f) => f.text);
      let body = clip(String(text || '').trim(), MAX_ANSWER); for (const f of fs) body += `${body ? '\n\n' : ''}--- ${f.name} ---\n${f.text}`;
      body = clip(body, MAX_ANSWER); if (!body) throw new Error('Type an answer, attach a file, or choose "Cannot provide".');
      r.status = 'answered'; r.answer = { text: body, files: fs.map((f) => ({ name: f.name, size: f.text.length })), by: 'god', at: Date.now() };
    }
    r.appliedAt = null;
    const task = this.tasks.get(r.taskId);
    this.talk(task || null, { from: 'god', to: r.by, kind: 'decision', text: r.status === 'declined' ? `I can't provide that: ${clip(r.what, 80)}` : `Re: ${clip(r.what, 80)}: ${clip(r.answer.text, 220)}` });
    this.emit('broadcast', { type: 'request', request: r }); this.save();
    return r;
  },

  /** What agents see: answers they can rely on, and what is still outstanding. */
  requestsText(task) {
    const mine = [...this.inboxState().values()].filter((r) => r.taskId === task.id); if (!mine.length) return '';
    const answered = mine.filter((r) => r.status === 'answered'); const open = mine.filter((r) => r.status === 'open'); const declined = mine.filter((r) => r.status === 'declined');
    const out = [];
    if (answered.length) out.push(`## Information from God (use it; it overrides assumptions)\n${answered.map((r) => `- Asked: ${r.what}\n  Answer${r.answer.by !== 'god' ? ` (from ${r.answer.by})` : ''}: ${clip(r.answer.text, 2500)}`).join('\n')}`);
    if (open.length || declined.length) out.push(`## Still unanswered (work with labelled assumptions)\n${[...open, ...declined].map((r) => `- ${r.what}${r.status === 'declined' ? ' (God cannot provide this)' : ''}`).join('\n')}`);
    return out.join('\n\n');
  },

  /** Send the deliverables that raised answered requests back for an update. Intake-level answers update every finished deliverable. */
  async applyAnswers(taskId) {
    const task = this.tasks.get(taskId); if (!task) throw new Error('No such task.');
    const todo = [...this.inboxState().values()].filter((r) => r.taskId === taskId && r.status === 'answered' && !r.appliedAt); if (!todo.length) throw new Error('Nothing new to apply.');
    const ready = task.subtasks.filter((s) => s.status === 'done' && s.outputId && this.deliverables.has(s.outputId) && this.agent(s.agent));
    // each answer remembers which deliverables it has already updated, so a failure halfway resumes without repeats
    const pendingFor = (sub) => todo.filter((r) => (!r.subId || r.subId === sub.id) && !(r.appliedTo || []).includes(sub.id));
    let n = 0;
    for (const sub of ready) {
      const mine = pendingFor(sub); if (!mine.length) continue;
      const a = this.agent(sub.agent); const d = this.deliverables.get(sub.outputId);
      const feedback = `God has answered what you asked for. Update the deliverable using it, replace the matching assumptions, and keep everything else.\n${mine.map((r) => `Asked: ${r.what}\nAnswer: ${clip(r.answer.text, 3000)}`).join('\n\n')}`;
      if (this.llm.mode === 'mock') {
        d.markdown += `\n\n## Update after God's answers\n${mine.map((r) => `- **${r.what}** Answer received: ${clip(r.answer.text, 300)}. The earlier assumption for this item is replaced by it.`).join('\n')}\n`; d.revised = true;
        this.emit('broadcast', { type: 'deliverable', deliverable: this.deliverableMeta(d) }); this.talk(task, { from: a.id, to: 'god', kind: 'status', text: `Updated my ${sub.skill} with your answer${mine.length > 1 ? 's' : ''}.` });
      } else { await this.revise(task, sub, feedback); }
      for (const r of mine) (r.appliedTo ||= []).push(sub.id);
      n++; this.save();
    }
    // an answer is done once it reached every deliverable it was for; one whose workstream left nothing to update is reported, not counted
    let applied = 0, unmatched = 0;
    for (const r of todo) {
      const targets = ready.filter((s) => !r.subId || r.subId === s.id);
      r.appliedAt = Date.now();
      if (targets.length) applied++; else { unmatched++; r.unmatched = true; }
    }
    task.answersApplied = (task.answersApplied || 0) + applied; this.pushTask(task);
    this.addLog(`Applied ${applied} answer(s) to ${n} deliverable(s) on ${taskId}${unmatched ? `; ${unmatched} had no finished deliverable to update and stay in the task's context for future work` : ''}`, { type: 'task', taskId });
    this.emit('broadcast', { type: 'requests', requests: this.requestsPublic() }); this.save();
    return { applied, updated: n, unmatched };
  },

  /** A stopped task no longer needs answers: its open requests leave the "needs you" list. */
  withdrawRequests(taskId) {
    let n = 0; for (const r of this.inboxState().values()) if (r.taskId === taskId && r.status === 'open') { r.status = 'withdrawn'; n++; this.emit('broadcast', { type: 'request', request: r }); }
    return n;
  },

  requestsPublic() { return [...this.inboxState().values()].sort((a, b) => b.created - a.created).slice(0, 200); },
  inboxSave() { return [...this.inboxState().values()]; },
  inboxLoad(list) { for (const r of list || []) this.inboxState().set(r.id, r); },
};
