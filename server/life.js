// Ambient office life: when nobody has been given work, 4EVR still feels alive.
import { smallTalk, IDLE_THOUGHTS } from './mock.js';

const rnd = (n) => Math.floor(Math.random() * n);
const choice = (arr) => arr[rnd(arr.length)];

export class Life {
  constructor(sim, bus) {
    this.sim = sim; this.bus = bus;
    this.occupied = new Set(); // spot keys in use
    this.enabled = true;
  }

  start() {
    for (const a of this.sim.agents.values()) this.loop(a);
  }

  async loop(a) {
    const sim = this.sim;
    await sim.sleep(2 + Math.random() * 6, sim.newTok(a));
    for (;;) {
      if (!this.enabled || a.busy || a.ambientLock) { await sim.sleep(2 + Math.random() * 2, a.tok); continue; }
      a.ambientLock = true;
      const tok = a.tok;
      try { await this.doSomething(a, tok); } catch (e) { console.error('ambient error', a.id, e); }
      a.ambientLock = false;
      if (tok.cancelled) { await sim.sleep(0.5, a.tok); continue; }
      await sim.sleep(6 + Math.random() * 14, a.tok);
    }
  }

  free(a) { return !a.busy && !a.tok.cancelled; }

  async doSomething(a, tok) {
    const sim = this.sim;
    const roll = Math.random();
    const lowEnergy = a.energy < 40;
    if (lowEnergy || roll < 0.2) return this.coffee(a, tok);
    if (roll < 0.45) return this.chat(a, tok);
    if (roll < 0.55) return this.whiteboard(a, tok);
    if (roll < 0.63) return this.vault(a, tok);
    if (roll < 0.71) return this.watercooler(a, tok);
    if (roll < 0.79) return this.pingpong(a, tok);
    if (roll < 0.86) return this.couch(a, tok);
    return this.tinker(a, tok);
  }

  async home(a, tok) {
    const sim = this.sim; const s = a.desk.seat;
    const ok = await sim.goTo(a, s, { pose: 'sit', tok });
    return ok;
  }

  async tinker(a, tok) {
    const sim = this.sim;
    if (!(await this.home(a, tok))) return;
    sim.setStatus(a, choice(IDLE_THOUGHTS));
    a.pose = 'type';
    if (Math.random() < 0.4) sim.emoteFor(a, choice(['bulb', 'dots', 'star']), 2.5);
    await sim.sleep(5 + Math.random() * 8, tok);
    if (!tok.cancelled) a.pose = 'sit';
  }

  async coffee(a, tok) {
    const sim = this.sim; const c = sim.map.spots.coffee;
    sim.setStatus(a, 'Coffee run');
    if (!(await sim.goTo(a, { ...c, dir: 'up' }, { tok }))) return;
    a.dir = 'up'; a.pose = 'drink'; sim.emoteFor(a, 'coffee', 3);
    await sim.sleep(4 + Math.random() * 3, tok);
    if (tok.cancelled) return;
    a.mood = Math.min(100, a.mood + 6); a.energy = Math.min(100, a.energy + 18);
    if (Math.random() < 0.3) sim.say(a, choice(a.quirks), 4);
    a.pose = 'stand';
    // sometimes bump into someone by the machine
    await this.tinker(a, tok);
  }

  async couch(a, tok) {
    const sim = this.sim; const spot = choice(sim.map.spots.couch.concat(sim.map.spots.beanbag));
    sim.setStatus(a, 'Taking five');
    if (!(await sim.goTo(a, spot, { pose: 'sit', tok }))) return;
    sim.emoteFor(a, choice(['zzz', 'heart', 'star']), 3);
    a.pose = 'sleep'; a.energy = Math.min(100, a.energy + 5);
    await sim.sleep(6 + Math.random() * 8, tok);
    if (!tok.cancelled) { a.mood = Math.min(100, a.mood + 5); a.pose = 'stand'; }
  }

  async watercooler(a, tok) {
    const sim = this.sim; const s = sim.map.spots.watercooler;
    sim.setStatus(a, 'At the water cooler');
    if (!(await sim.goTo(a, { ...s, dir: 'up' }, { tok }))) return;
    a.pose = 'drink'; await sim.sleep(3, tok);
    if (tok.cancelled) return;
    // find a colleague passing by to chat
    const other = [...sim.agents.values()].find((o) => o !== a && this.free(o) && !o.ambientLock && Math.hypot(o.x - a.x, o.y - a.y) < 8);
    if (other && Math.random() < 0.6) {
      other.ambientLock = true; sim.claim(other);
      try { await this.talkPair(a, other, tok, { meetAt: s }); } finally { other.ambientLock = false; }
    }
    a.pose = 'stand';
  }

  async whiteboard(a, tok) {
    const sim = this.sim; const spot = sim.map.spots[`whiteboard_${a.room}`];
    if (!spot) return this.tinker(a, tok);
    sim.setStatus(a, 'Sketching on the whiteboard');
    if (!(await sim.goTo(a, { tx: spot.tx, ty: spot.ty, dir: 'up' }, { tok }))) return;
    a.dir = 'up'; a.pose = 'type'; sim.emoteFor(a, 'bulb', 3);
    await sim.sleep(6 + Math.random() * 6, tok);
    if (!tok.cancelled) a.pose = 'stand';
  }

  async vault(a, tok) {
    const sim = this.sim; const spot = choice(sim.map.spots.vault);
    sim.setStatus(a, 'Browsing the Skill Vault');
    if (!(await sim.goTo(a, spot, { tok }))) return;
    a.pose = 'type'; sim.emoteFor(a, 'book', 3);
    const skill = choice(a.skills);
    sim.say(a, `Re-reading the ${skill} playbook`, 4);
    // self-study: search and read the real web about the craft (bounded by the learning mode and budget)
    if (this.bus.canStudy?.() && Math.random() < 0.6) await this.bus.study(a, tok);
    else await sim.sleep(6 + Math.random() * 5, tok);
    if (!tok.cancelled) a.pose = 'stand';
  }

  async pingpong(a, tok) {
    const sim = this.sim;
    const partner = [...sim.agents.values()].find((o) => o !== a && this.free(o) && !o.ambientLock && Math.random() < 0.5);
    if (!partner) return this.couch(a, tok);
    partner.ambientLock = true;
    const [p1, p2] = sim.map.spots.pingpong;
    sim.setStatus(a, 'Ping pong'); sim.setStatus(partner, 'Ping pong');
    sim.claim(partner);
    const ptok = partner.tok;
    try {
      const [ok1, ok2] = await Promise.all([sim.goTo(a, { ...p1, dir: 'right' }, { tok }), sim.goTo(partner, { ...p2, dir: 'left' }, { tok: ptok })]);
      if (!ok1 || !ok2) return;
      a.dir = 'right'; partner.dir = 'left'; a.pose = 'play'; partner.pose = 'play';
      sim.say(a, 'Serve!', 2);
      for (let i = 0; i < 3 && !tok.cancelled && !ptok.cancelled; i++) {
        await sim.sleep(2.5, tok);
        sim.say(i % 2 ? a : partner, choice(['Ha!', 'Nice one.', 'Ooh.', 'Too easy.', 'No way.']), 1.6);
      }
      if (!tok.cancelled) { a.mood = Math.min(100, a.mood + 8); partner.mood = Math.min(100, partner.mood + 8); }
    } finally { partner.ambientLock = false; a.pose = 'stand'; partner.pose = 'stand'; }
  }

  async chat(a, tok) {
    const sim = this.sim;
    const others = [...sim.agents.values()].filter((o) => o !== a && this.free(o) && !o.ambientLock);
    if (!others.length) return this.tinker(a, tok);
    const mates = others.filter((o) => o.dept === a.dept);
    const b = mates.length && Math.random() < 0.6 ? choice(mates) : choice(others); // people talk to their own team more
    b.ambientLock = true; sim.claim(b);
    try { const link = this.bus.workChat?.(a, b); await this.talkPair(a, b, tok, { visit: true, lines: link?.lines, taskId: link?.taskId }); } finally { b.ambientLock = false; }
  }

  /** Two agents have a short ambient conversation. */
  async talkPair(a, b, tok, { visit = false, meetAt, lines, taskId } = {}) {
    const sim = this.sim; const ptok = b.tok;
    sim.setStatus(a, `Chatting with ${b.short}`); sim.setStatus(b, `Chatting with ${a.short}`);
    let ok;
    if (visit) {
      // a walks over to b's desk (or wherever b is)
      const at = sim.nearestWalkable({ tx: Math.floor(b.x) + 1, ty: Math.floor(b.y) });
      ok = await sim.goTo(a, { ...at, dir: 'left' }, { tok });
      b.dir = 'right';
    } else {
      const m = meetAt || sim.map.spots.watercooler;
      const left = sim.nearestWalkable({ tx: m.tx - 1, ty: m.ty });
      ok = await sim.goTo(b, { ...left, dir: 'right' }, { tok: ptok });
      a.dir = 'left';
    }
    if (!ok || tok.cancelled || ptok.cancelled) return;
    const [l1, l2] = lines || smallTalk(Math.random() * 1e6);
    const kind = lines ? 'status' : 'banter'; // shared work gets talked about, not just the weather
    a.pose = 'talk'; sim.say(a, l1, 4.5); this.bus.emit('comms', { from: a.id, to: b.id, text: l1, kind, taskId });
    await sim.sleep(4.8, tok); if (tok.cancelled) return;
    b.pose = 'talk'; a.pose = 'stand'; sim.say(b, l2, 4.5); this.bus.emit('comms', { from: b.id, to: a.id, text: l2, kind, taskId });
    await sim.sleep(4.8, tok);
    a.mood = Math.min(100, a.mood + 4); b.mood = Math.min(100, b.mood + 4);
    a.pose = 'stand'; b.pose = 'stand';
  }
}
