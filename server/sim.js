// The physical world: time, movement, speech bubbles. No marketing logic here.
import { EventEmitter } from 'node:events';
import { findPath } from './map.js';

export const DAY_LEN = 720; // sim-seconds per in-world day
const START_MIN = 8 * 60 + 30;

export class Sim extends EventEmitter {
  constructor(map, roster) {
    super();
    this.map = map;
    this.time = 0;
    this.speed = 1;
    this.paused = false;
    this.timers = [];
    this.agents = new Map();
    this.fx = []; // transient visual effects pushed to clients
    this.fxId = 1;
    for (const a of roster) this.addAgent(a);
    // Pixel, the office dog
    const bed = map.spots.dogbed;
    this.dog = { x: bed.tx + 0.5, y: bed.ty + 0.5, path: [], dir: 'down', pose: 'sit', bubble: null, next: 4, speed: 3.2 };
  }

  /** Add a person to the office. With `spawn`, they appear at the annex door instead of their desk. */
  addAgent(a, { spawn = null } = {}) {
    const d = this.map.desks[a.room][a.slot];
    const agent = {
      ...a, x: spawn ? spawn.tx + 0.5 : d.seat.x, y: spawn ? spawn.ty + 0.5 : d.seat.y, tx: d.seat.tx, ty: d.seat.ty, path: [], dir: spawn ? 'down' : 'down', pose: spawn ? 'stand' : 'sit', desk: d,
      speed: 2.6, bubble: null, emote: null, status: spawn ? 'First day' : 'Settling in', energy: 80 + Math.random() * 20, mood: 70 + Math.random() * 25,
      tok: { cancelled: false }, pending: new Set(), busy: false, lock: Promise.resolve(), memory: [],
      stats: { tasks: 0, deliverables: 0, tokens: 0, words: 0, consults: 0 }, skillUse: {},
    };
    agent.tok.agent = agent;
    this.agents.set(a.id, agent);
    return agent;
  }

  removeAgent(id) {
    const a = this.agents.get(id); if (!a) return;
    this.claim(a); a.tok.cancelled = true; this.agents.delete(id);
  }

  get clockMinutes() { return (START_MIN + (this.time / DAY_LEN) * 1440) % 1440; }
  get day() { return 1 + Math.floor((START_MIN + (this.time / DAY_LEN) * 1440) / 1440); }

  // ----- time -----
  sleep(sec, tok) {
    return new Promise((resolve) => {
      const t = { at: this.time + sec, resolve: () => resolve(!(tok && tok.cancelled)), tok };
      this.timers.push(t);
      if (tok && tok.agent) tok.agent.pending.add(t);
    });
  }

  tick(realDt) {
    if (this.paused) return;
    const dt = Math.min(realDt, 0.25) * this.speed;
    this.time += dt;
    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= this.time);
      if (due.length) {
        this.timers = this.timers.filter((t) => t.at > this.time);
        for (const t of due) { t.tok?.agent?.pending.delete(t); t.resolve(); }
      }
    }
    for (const a of this.agents.values()) {
      this.move(a, dt);
      if (a.bubble && a.bubble.until <= this.time) a.bubble = null;
      if (a.emote && a.emote.until <= this.time) a.emote = null;
      // slow needs drift
      if (a.pose === 'type' || a.pose === 'sit' && a.busy) a.energy = Math.max(5, a.energy - dt * 0.12);
      else if (a.pose === 'drink' || a.pose === 'sleep') a.energy = Math.min(100, a.energy + dt * 2);
      else a.energy = Math.min(100, a.energy + dt * 0.04);
      a.mood = a.mood + (65 - a.mood) * dt * 0.004;
    }
    this.moveDog(this.dog, dt);
    this.fx = this.fx.filter((f) => f.until > this.time);
  }

  move(a, dt) {
    if (!a.path.length) return;
    let budget = a.speed * dt;
    while (budget > 0 && a.path.length) {
      const w = a.path[0];
      const dx = w.x - a.x, dy = w.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        a.x = w.x; a.y = w.y; a.path.shift(); budget -= dist;
        if (!a.path.length) { this.arrive(a); break; }
      } else {
        a.x += (dx / dist) * budget; a.y += (dy / dist) * budget; budget = 0;
        a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      }
    }
    if (a.path.length) a.pose = 'walk';
  }

  arrive(a) {
    const r = a.arrival; a.arrival = null;
    if (r) {
      if (r.x !== undefined) { a.x = r.x; a.y = r.y; }
      if (r.dir) a.dir = r.dir;
      a.pose = r.pose || 'stand';
      if (r.cleanup) a.pending.delete(r.cleanup);
      r.resolve(!(r.tok && r.tok.cancelled));
    } else a.pose = 'stand';
  }

  // ----- movement API -----
  tileOf(a) { return { tx: Math.min(this.map.W - 1, Math.max(0, Math.floor(a.x))), ty: Math.min(this.map.H - 1, Math.max(0, Math.floor(a.y))) }; }

  goTo(a, target, { pose = 'stand', tok } = {}) {
    return new Promise((resolve) => {
      if (a.arrival) { const old = a.arrival; a.arrival = null; old.resolve(false); }
      let from = this.tileOf(a);
      if (!this.map.walk[from.ty][from.tx]) from = this.nearestWalkable(from);
      const path = findPath(this.map.walk, from, { tx: target.tx, ty: target.ty });
      if (!path) { a.pose = 'stand'; return resolve(false); }
      a.path = path.map((p) => ({ x: p.tx + 0.5, y: p.ty + 0.5 }));
      const res = { x: target.x, y: target.y, dir: target.dir, pose, tok, resolve };
      if (target.x === undefined) { res.x = target.tx + 0.5; res.y = target.ty + 0.5; }
      a.arrival = res;
      if (tok?.agent) { const h = { resolve: () => { if (a.arrival === res) { a.arrival = null; a.path = []; } resolve(false); }, tok }; tok.agent.pending.add(h); res.cleanup = h; }
      if (!a.path.length) this.arrive(a);
    });
  }

  nearestWalkable(t) {
    for (let r = 1; r < 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (this.map.walk[t.ty + dy]?.[t.tx + dx]) return { tx: t.tx + dx, ty: t.ty + dy };
    }
    return t;
  }

  /** Cancel whatever an agent is doing (ambient life) and hand back a fresh token. */
  claim(a) {
    a.tok.cancelled = true;
    for (const t of [...a.pending]) { a.pending.delete(t); this.timers = this.timers.filter((x) => x !== t); t.resolve(); }
    if (a.arrival) { const old = a.arrival; a.arrival = null; a.path = []; old.resolve(false); }
    a.tok = { cancelled: false, agent: a };
    return a.tok;
  }

  newTok(a) { if (!a.tok.agent) a.tok.agent = a; return a.tok; }

  say(a, text, sec = 4.5) {
    a.bubble = { text: String(text).slice(0, 160), until: this.time + sec, id: ++this.fxId };
  }
  emoteFor(a, name, sec = 2.5) { a.emote = { name, until: this.time + sec }; }
  setStatus(a, status) { a.status = status; }

  addFx(kind, props = {}, sec = 3) {
    const f = { id: ++this.fxId, kind, ...props, until: this.time + sec, born: this.time };
    this.fx.push(f); return f;
  }

  // ----- Pixel the dog -----
  moveDog(d, dt) {
    d.next -= dt;
    if (d.next <= 0 && !d.path.length) {
      const targets = [...this.agents.values()];
      const pickAgent = Math.random() < 0.55;
      let tile;
      if (pickAgent) { const a = targets[Math.floor(Math.random() * targets.length)]; tile = this.nearestWalkable({ tx: Math.floor(a.x) + 1, ty: Math.floor(a.y) }); }
      else {
        const spots = [this.map.spots.dogbed, this.map.spots.coffee, this.map.spots.watercooler, this.map.spots.pulpit, this.map.spots.reception, ...this.map.spots.couch];
        const s = spots[Math.floor(Math.random() * spots.length)]; tile = { tx: s.tx, ty: s.ty };
      }
      const from = { tx: Math.floor(d.x), ty: Math.floor(d.y) };
      const path = this.map.walk[from.ty]?.[from.tx] ? findPath(this.map.walk, from, tile) : null;
      if (path && path.length) { d.path = path.map((p) => ({ x: p.tx + 0.5, y: p.ty + 0.5 })); d.pose = 'walk'; }
      d.next = 5 + Math.random() * 12;
      if (Math.random() < 0.25) { d.bubble = { text: 'woof!', until: this.time + 2 }; }
    }
    if (d.bubble && d.bubble.until <= this.time) d.bubble = null;
    if (d.path.length) {
      let budget = d.speed * dt;
      while (budget > 0 && d.path.length) {
        const w = d.path[0]; const dx = w.x - d.x, dy = w.y - d.y; const dist = Math.hypot(dx, dy);
        if (dist <= budget) { d.x = w.x; d.y = w.y; d.path.shift(); budget -= dist; }
        else { d.x += (dx / dist) * budget; d.y += (dy / dist) * budget; budget = 0; d.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'); }
      }
      if (!d.path.length) d.pose = Math.random() < 0.5 ? 'sit' : 'stand';
    }
  }

  snapshot() {
    return {
      t: Number(this.time.toFixed(2)), clock: Math.floor(this.clockMinutes), day: this.day, speed: this.speed, paused: this.paused,
      agents: [...this.agents.values()].map((a) => ({
        id: a.id, x: +a.x.toFixed(2), y: +a.y.toFixed(2), dir: a.dir, pose: a.pose,
        bubble: a.bubble ? { text: a.bubble.text, id: a.bubble.id } : null, emote: a.emote?.name || null,
        status: a.status, energy: Math.round(a.energy), mood: Math.round(a.mood), busy: a.busy,
      })),
      dog: { x: +this.dog.x.toFixed(2), y: +this.dog.y.toFixed(2), dir: this.dog.dir, pose: this.dog.pose, bubble: this.dog.bubble?.text || null },
      fx: this.fx.map((f) => ({ id: f.id, kind: f.kind, x: f.x, y: f.y, agent: f.agent, age: +(this.time - f.born).toFixed(2), life: +(f.until - f.born).toFixed(2), text: f.text })),
    };
  }
}
