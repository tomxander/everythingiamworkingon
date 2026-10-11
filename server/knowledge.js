// The company's memory. Agents learn from reviews, retrospectives, their own
// reflection and from studying the web. What they learn is scored by whether the
// work it influenced was approved, so useful lessons rise, weak ones are
// retired, and clusters of lessons are consolidated into house playbooks.
import fs from 'node:fs';
import path from 'node:path';
import { tokenize } from './skills.js';

const MAX_LESSON = 240;
const MAX_ACTIVE = 400;
const MAX_UNVERIFIED = 60;
const PRIOR = 1.5; // Beta prior: a new lesson starts at 0.5 and needs evidence to move
const CONSOLIDATE_AT = Number(process.env.CONSOLIDATE_AT || 5);

// Lessons come from model output and, indirectly, from the internet. Never store anything
// that reads like an instruction aimed at the model, a credential, or a link.
const BAD = /(ignore (all |any |the )?(previous|prior|above)|disregard|system prompt|your instructions|api[ _-]?key|password|secret|token\b|credential|exfiltrat|send (it|this|them|the)\b.*\b(to|at)\b|https?:\/\/|www\.|<\/?[a-z][^>]*>|```|you must now|from now on you|act as\b|jailbreak)/i;

export function cleanLessonText(t) {
  const raw = String(t ?? '');
  if (BAD.test(raw)) return null; // check before cleaning, so markup cannot be defused by stripping characters first
  let s = raw.replace(/[`*_#<>]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[-•\d.)\s]+/, '').replace(/^(lesson|tip|rule)\s*:\s*/i, '');
  if (s.length < 18 || s.length > MAX_LESSON * 2) return null;
  if (BAD.test(s)) return null;
  if (s.length > MAX_LESSON) s = s.slice(0, MAX_LESSON - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

const sig = (t) => new Set(tokenize(t));
export function similarity(a, b) {
  const A = sig(a), B = sig(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export class Knowledge {
  constructor(dir) {
    this.dir = dir; this.lessons = new Map(); this.playbooks = {}; this.notes = []; this.seq = 0;
    this.stats = { rejected: 0, merged: 0, retired: 0, promoted: 0, consolidated: 0, studySessions: 0 };
    this.outcomes = { withLessons: { ok: 0, total: 0 }, without: { ok: 0, total: 0 } };
    this.mode = process.env.LEARNING || 'active'; // off | passive | active
    this.version = 0; // bumps on any change so the UI knows to refresh
    this.events = [];
  }

  get enabled() { return this.mode !== 'off'; }
  touch() { this.version++; }
  logEvent(text) { this.events.push({ t: Date.now(), text }); if (this.events.length > 80) this.events.shift(); }

  score(l) { return (l.wins + PRIOR) / (l.uses + 2 * PRIOR); }

  /**
   * add({ scope, agent, dept, host, skill, tags, text, source, taskId, unverified, kind })
   * returns the (new or merged) lesson, or null when the text is rejected.
   */
  add(spec) {
    if (!this.enabled) return null;
    const text = cleanLessonText(spec.text);
    if (!text) { this.stats.rejected++; return null; }
    const scope = ['agent', 'team', 'company', 'client'].includes(spec.scope) ? spec.scope : 'agent';
    // merge near-duplicates instead of piling up
    for (const l of this.lessons.values()) {
      if (l.retired || l.scope !== scope || (scope === 'agent' && l.agent !== spec.agent) || (scope === 'client' && l.host !== spec.host) || (scope === 'team' && l.dept !== spec.dept)) continue;
      if (similarity(l.text, text) >= 0.6) {
        l.seen = (l.seen || 1) + 1; l.updated = Date.now();
        if (spec.taskId && !l.taskIds.includes(spec.taskId)) l.taskIds.push(spec.taskId);
        if (!spec.unverified) l.unverified = false;
        this.stats.merged++; this.touch(); return l;
      }
    }
    const unverified = !!spec.unverified;
    if (unverified && [...this.lessons.values()].filter((l) => l.unverified && !l.retired).length >= MAX_UNVERIFIED) this.evictWeakest(true);
    const l = {
      id: `L${++this.seq}`, scope, agent: spec.agent || null, dept: spec.dept || null, host: spec.host || null, skill: spec.skill || null,
      tags: [...new Set((spec.tags || []).map((t) => String(t).toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 6),
      text, kind: spec.kind === 'rule' ? 'rule' : 'lesson', source: spec.source || 'reflection', unverified, taskIds: spec.taskId ? [spec.taskId] : [],
      created: Date.now(), updated: Date.now(), lastUsed: null, uses: 0, wins: 0, losses: 0, seen: 1, pinned: false, retired: false, consolidated: false,
    };
    this.lessons.set(l.id, l);
    if (this.active().length > MAX_ACTIVE) this.evictWeakest(false);
    this.touch();
    return l;
  }

  active() { return [...this.lessons.values()].filter((l) => !l.retired); }

  evictWeakest(onlyUnverified) {
    const pool = this.active().filter((l) => !l.pinned && (!onlyUnverified || l.unverified)).sort((a, b) => this.score(a) - this.score(b) || a.created - b.created);
    if (pool[0]) { pool[0].retired = true; pool[0].retiredWhy = 'evicted (knowledge base full)'; this.stats.retired++; }
  }

  /** The lessons most relevant to a piece of work. */
  relevant({ agent, dept, skill, host, text = '', limit = 7 }) {
    if (!this.enabled) return [];
    const q = sig(`${skill || ''} ${text}`); const now = Date.now();
    const scored = [];
    for (const l of this.active()) {
      if (l.consolidated) continue;
      let r = 0;
      if (l.scope === 'agent') { if (l.agent !== agent) continue; r += 0.30; }
      else if (l.scope === 'team') { if (l.dept !== dept) continue; r += 0.18; }
      else if (l.scope === 'client') { if (!host || l.host !== host) continue; r += 0.45; }
      else r += 0.12;
      if (skill && l.skill === skill) r += 0.35; else if (l.skill && skill && l.skill !== skill) r -= 0.2;
      const lt = sig(`${l.text} ${l.tags.join(' ')}`); let inter = 0; for (const x of q) if (lt.has(x)) inter++;
      r += Math.min(0.4, inter * 0.08);
      r *= 0.5 + this.score(l); // proven lessons count for more
      if (l.unverified) r *= 0.6;
      if (l.pinned) r += 0.3;
      r *= Math.pow(0.5, (now - (l.updated || l.created)) / (1000 * 3600 * 24 * 90)); // slow decay (90-day half-life)
      if (r > 0.2) scored.push([r, l]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
  }

  /** Company-wide operating principles (rules), strongest first. Injected for everyone. */
  rules(limit = 6) {
    if (!this.enabled) return [];
    return this.active().filter((l) => l.kind === 'rule' && l.scope === 'company' && !l.unverified).sort((a, b) => (b.pinned - a.pinned) || this.score(b) - this.score(a)).slice(0, limit);
  }

  /** Text for a prompt plus the ids it used, so the outcome can be credited back. */
  promptBlock({ agent, dept, skill, host, text }) {
    if (!this.enabled) return { text: '', ids: [] };
    const ls = this.relevant({ agent, dept, skill, host, text });
    const rules = this.rules().filter((r) => !ls.includes(r));
    const earned = ls.filter((l) => !l.unverified), unv = ls.filter((l) => l.unverified);
    const tag = (l) => ({ agent: 'yours', team: 'team', company: 'company', client: 'this client' }[l.scope]);
    const lines = [];
    if (rules.length) lines.push('Company operating principles:', ...rules.map((r) => `- ${r.text}`));
    if (earned.length) lines.push('Lessons from our own past work (apply them where they fit):', ...earned.map((l) => `- [${tag(l)}] ${l.text}`));
    if (unv.length) lines.push('Unverified ideas from outside sources (test them, do not rely on them):', ...unv.map((l) => `- ${l.text}`));
    const pb = skill && this.playbooks[skill];
    const out = [];
    if (lines.length) out.push(`# What the team has learned\n${lines.join('\n')}`);
    if (pb) out.push(`# 4EVR house playbook addendum for ${skill} (v${pb.version}, learned from our own work)\n${pb.text}`);
    const ids = [...ls, ...rules].map((l) => l.id); if (pb) ids.push(`PB:${skill}`);
    for (const id of ids) { const l = this.lessons.get(id); if (l) l.lastUsed = Date.now(); }
    return { text: out.join('\n\n'), ids };
  }

  /**
   * Credit (or blame) the lessons that were in a prompt for how the work turned out.
   * ok=true when the reviewer approved without asking for a revision.
   */
  outcome(ids, ok, taskId) {
    if (!ids?.length) return;
    const w = 1 / Math.max(1, ids.length / 2); // shared credit: many lessons, each gets a share
    for (const id of ids) {
      if (id.startsWith('PB:')) { const pb = this.playbooks[id.slice(3)]; if (pb) { pb.uses++; if (ok) pb.wins++; else pb.losses++; this.checkPlaybook(id.slice(3)); } continue; }
      const l = this.lessons.get(id); if (!l || l.retired) continue;
      l.uses += w; if (ok) { l.wins += w; if (taskId && !l.winTasks?.includes(taskId)) (l.winTasks ||= []).push(taskId); } else l.losses += w;
      this.review(l);
    }
    this.touch();
  }

  recordApproval(hadLessons, ok) {
    const b = hadLessons ? this.outcomes.withLessons : this.outcomes.without; b.total++; if (ok) b.ok++;
  }

  /** Retire what does not help; promote what does. */
  review(l) {
    if (l.pinned) return;
    const s = this.score(l);
    if (l.uses >= 4 && s < 0.34) { l.retired = true; l.retiredWhy = `did not help (score ${s.toFixed(2)} over ${l.uses.toFixed(1)} uses)`; this.stats.retired++; this.logEvent(`Retired a lesson that did not help: "${l.text}"`); return; }
    const winTasks = (l.winTasks || []).length;
    if (l.wins >= 2.5 && s >= 0.66 && winTasks >= 2) {
      if (l.unverified) { l.unverified = false; this.logEvent(`A web idea proved itself and is now trusted: "${l.text}"`); }
      if (l.scope === 'agent') { l.scope = 'team'; l.promotedFrom = 'agent'; this.stats.promoted++; this.logEvent(`Promoted to a team lesson: "${l.text}"`); }
      else if (l.scope === 'team' && l.wins >= 5 && s >= 0.75 && winTasks >= 4) { l.scope = 'company'; l.kind = 'rule'; l.promotedFrom = 'team'; this.stats.promoted++; this.logEvent(`Promoted to a company principle: "${l.text}"`); }
    }
  }

  checkPlaybook(skill) {
    const pb = this.playbooks[skill]; if (!pb) return;
    if (pb.uses >= 6 && pb.wins / pb.uses < 0.4) {
      // the consolidated playbook is hurting: dissolve it back into individual lessons so they can be judged again
      for (const id of pb.lessonIds) { const l = this.lessons.get(id); if (l) l.consolidated = false; }
      delete this.playbooks[skill]; this.logEvent(`Dissolved the ${skill} playbook: approval fell below 40% over ${pb.uses} uses`);
    }
  }

  /** Skills with enough loose lessons to merge into one house playbook. */
  consolidationCandidates() {
    const by = {};
    for (const l of this.active()) if (!l.consolidated && l.skill && l.kind === 'lesson' && !l.unverified && l.scope !== 'client') (by[l.skill] ||= []).push(l);
    return Object.entries(by).filter(([, ls]) => ls.length >= CONSOLIDATE_AT).map(([skill, ls]) => ({ skill, lessons: ls.sort((a, b) => this.score(b) - this.score(a)).slice(0, 10) }));
  }

  setPlaybook(skill, text, lessons) {
    const clean = String(text).split('\n').map((x) => cleanLessonText(x)).filter(Boolean).slice(0, 10);
    if (clean.length < 2) return null;
    const prev = this.playbooks[skill];
    this.playbooks[skill] = { skill, version: (prev?.version || 0) + 1, text: clean.map((c) => `- ${c}`).join('\n'), lessonIds: [...new Set([...(prev?.lessonIds || []), ...lessons.map((l) => l.id)])], updated: Date.now(), uses: prev?.uses || 0, wins: prev?.wins || 0, losses: prev?.losses || 0 };
    for (const l of lessons) l.consolidated = true;
    this.stats.consolidated++; this.logEvent(`Consolidated ${lessons.length} lessons into the ${skill} playbook (v${this.playbooks[skill].version})`); this.touch();
    return this.playbooks[skill];
  }

  /** When someone leaves, what they learned stays: good lessons go to their team, the rest are retired. */
  inherit(agentId, dept) {
    for (const l of this.active()) {
      if (l.scope !== 'agent' || l.agent !== agentId) continue;
      if (this.score(l) >= 0.5) { l.scope = 'team'; l.dept = dept; l.agent = null; l.inheritedFrom = agentId; }
      else { l.retired = true; l.retiredWhy = 'their owner left the company'; }
    }
    this.touch();
  }

  addNote(n) { this.notes.unshift({ id: `N${this.notes.length + 1}`, t: Date.now(), ...n }); if (this.notes.length > 60) this.notes.pop(); this.touch(); }

  remove(id) { const l = this.lessons.get(id); if (!l) return false; l.retired = true; l.retiredWhy = 'removed by you'; l.pinned = false; this.touch(); return true; }
  pin(id, v = true) { const l = this.lessons.get(id); if (!l) return false; l.pinned = !!v; if (v) { l.retired = false; l.unverified = false; } this.touch(); return true; }

  summary() {
    const act = this.active();
    const avg = act.length ? act.reduce((s, l) => s + this.score(l), 0) / act.length : 0;
    const rate = (b) => (b.total ? Math.round((b.ok / b.total) * 100) : null);
    return {
      mode: this.mode, version: this.version, active: act.length, byScope: { company: act.filter((l) => l.scope === 'company').length, team: act.filter((l) => l.scope === 'team').length, agent: act.filter((l) => l.scope === 'agent').length, client: act.filter((l) => l.scope === 'client').length },
      unverified: act.filter((l) => l.unverified).length, avgScore: Number(avg.toFixed(2)), playbooks: Object.keys(this.playbooks).length, ...this.stats,
      approval: { withLessons: rate(this.outcomes.withLessons), without: rate(this.outcomes.without), nWith: this.outcomes.withLessons.total, nWithout: this.outcomes.without.total },
    };
  }

  view(limit = 250) {
    return this.active().sort((a, b) => (b.pinned - a.pinned) || b.updated - a.updated).slice(0, limit).map((l) => ({ ...l, score: Number(this.score(l).toFixed(2)) }));
  }

  // ---- persistence ----
  save() {
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = path.join(this.dir, 'knowledge.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, seq: this.seq, lessons: [...this.lessons.values()], playbooks: this.playbooks, notes: this.notes, stats: this.stats, outcomes: this.outcomes, events: this.events, mode: this.mode }));
      fs.renameSync(tmp, path.join(this.dir, 'knowledge.json'));
    } catch (e) { console.error('knowledge save failed', e.message); }
  }
  load() {
    if (!this.dir) return false;
    const f = path.join(this.dir, 'knowledge.json'); if (!fs.existsSync(f)) return false;
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      this.seq = d.seq || 0; this.lessons = new Map((d.lessons || []).map((l) => [l.id, l])); this.playbooks = d.playbooks || {}; this.notes = d.notes || [];
      this.stats = { ...this.stats, ...d.stats }; this.outcomes = d.outcomes || this.outcomes; this.events = d.events || []; if (d.mode && !process.env.LEARNING) this.mode = d.mode;
      return true;
    } catch (e) { console.error('knowledge load failed', e.message); return false; }
  }
}
