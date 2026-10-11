import { S, T, makeCanvas, rect, shade, drawFloorTile, drawWallTile, personFrame, dogFrame, emoteSprite } from './sprites.js';
import { renderFurniture, sortYOf, FLAT, WALL } from './furniture.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class Renderer {
  constructor(canvas, init) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.map = init.map; this.agentsInfo = Object.fromEntries(init.agents.map((a) => [a.id, a]));
    this.depts = init.depts;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.userMoved = false;
    this.hover = null; this.selected = null; this.follow = null;
    this.showNames = true;
    this.buildStatic();
    this.sprites = [];
    for (const it of this.map.furniture) {
      if (FLAT.has(it.type) || WALL.has(it.type) || it.type === 'monitor' || it.type === 'neon') continue;
      const { canvas: c, margin } = renderFurniture(it);
      this.sprites.push({ it, c, margin, sortY: sortYOf(it) });
    }
    this.anim = this.map.furniture.filter((f) => ['serverrack', 'holotable', 'coffee', 'pulpit'].includes(f.type));
    this.resize();
  }

  addAgent(info) { this.agentsInfo[info.id] = info; }
  removeAgent(id) { delete this.agentsInfo[id]; if (this.selected === id) this.selected = null; if (this.follow === id) this.follow = null; }

  // -------- static world layer (floors, walls, rugs, wall decor) --------
  buildStatic() {
    const { W, H, floor, wall, furniture, rooms } = this.map;
    const { c, ctx } = makeCanvas(W * T, H * T);
    rect(ctx, 0, 0, W * T, H * T, '#17364b');
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (floor[y][x] && !wall[y][x]) drawFloorTile(ctx, floor[y][x], x, y);
    }
    for (const it of furniture) {
      if (!FLAT.has(it.type)) continue;
      const { canvas, margin } = renderFurniture(it);
      ctx.drawImage(canvas, it.x * T, it.y * T - margin, canvas.width / S, canvas.height / S);
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (wall[y][x]) drawWallTile(ctx, x, y, y + 1 < H && !!floor[y + 1][x] && !wall[y + 1][x], wall);
    }
    for (const it of furniture) {
      if (!WALL.has(it.type)) continue;
      const { canvas, margin } = renderFurniture(it);
      ctx.drawImage(canvas, it.x * T, (it.y - 1) * T - margin, canvas.width / S, canvas.height / S);
    }
    // room names, stencilled on the floor so they never fight with wall decor
    ctx.font = 'bold 6px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const r of rooms) {
      const label = r.name.toUpperCase(); const x = (r.x + 1) * T + 3; const y = (r.y + r.h - 1) * T + (r.id === 'hub' ? -6 : 5);
      if (r.id === 'hub') continue;
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillText(label, x + 0.5, y + 0.8);
      ctx.fillStyle = 'rgba(255,255,255,0.42)'; ctx.fillText(label, x, y);
    }
    this.bg = c;
  }

  // -------- camera --------
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.dpr = dpr; this.vw = r.width; this.vh = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr)); this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    if (!this.userMoved) this.fit();
  }
  fit() {
    const ww = this.map.W * T, wh = this.map.H * T; const pad = 12;
    const z = Math.min((this.vw - pad * 2) / ww, (this.vh - pad * 2) / wh);
    this.cam.zoom = z; this.cam.x = (this.vw - ww * z) / 2; this.cam.y = (this.vh - wh * z) / 2;
    this.userMoved = false;
  }
  zoomAt(sx, sy, factor) {
    const z0 = this.cam.zoom; const z1 = clamp(z0 * factor, 0.5, 8);
    const wx = (sx - this.cam.x) / z0, wy = (sy - this.cam.y) / z0;
    this.cam.zoom = z1; this.cam.x = sx - wx * z1; this.cam.y = sy - wy * z1; this.userMoved = true;
  }
  pan(dx, dy) { this.cam.x += dx; this.cam.y += dy; this.userMoved = true; }
  centerOn(wx, wy, zoom) {
    if (zoom) this.cam.zoom = zoom;
    this.cam.x = this.vw / 2 - wx * T * this.cam.zoom; this.cam.y = this.vh / 2 - wy * T * this.cam.zoom; this.userMoved = true;
  }
  screenToWorld(sx, sy) { return { x: (sx - this.cam.x) / this.cam.zoom / T, y: (sy - this.cam.y) / this.cam.zoom / T }; }
  worldToScreen(wx, wy) { return { x: this.cam.x + wx * T * this.cam.zoom, y: this.cam.y + wy * T * this.cam.zoom }; }

  agentAt(sx, sy, snap) {
    const w = this.screenToWorld(sx, sy);
    let best = null, bd = 1.1;
    for (const a of snap.agents) {
      if (!this.agentsInfo[a.id]) continue;
      const d = Math.hypot(a.x - w.x, (a.y - 0.45) - w.y);
      if (d < bd) { bd = d; best = a; }
    }
    return best?.id || null;
  }

  // -------- frame --------
  draw(snap, ts, extra = {}) {
    const ctx = this.ctx; const t = ts / 1000; const { cam, dpr } = this;
    if (this.follow && snap) { const a = snap.agents.find((x) => x.id === this.follow); if (a) { this.cam.x += (this.vw / 2 - a.x * T * cam.zoom - cam.x) * 0.08; this.cam.y += (this.vh / 2 - a.y * T * cam.zoom - cam.y) * 0.08; } }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); // the glass stage shows through around the building
    ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * cam.x, dpr * cam.y);
    ctx.imageSmoothingEnabled = cam.zoom * dpr < S * 0.95; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.bg, 0, 0, this.map.W * T, this.map.H * T);
    if (!snap) return;

    this.drawNeon(ctx, t);

    // y-sorted entities
    const ents = this.sprites.map((s) => ({ kind: 'f', y: s.sortY, s }));
    for (const a of snap.agents) if (this.agentsInfo[a.id]) ents.push({ kind: 'a', y: a.y * T + 8, a }); // ignore anyone we have not been introduced to yet
    ents.push({ kind: 'd', y: snap.dog.y * T + 5, d: snap.dog });
    ents.sort((p, q) => p.y - q.y);
    const aliveAnim = new Set();
    for (const e of ents) {
      if (e.kind === 'f') {
        const { it, c, margin } = e.s;
        ctx.drawImage(c, it.x * T, it.y * T - margin, c.width / S, c.height / S);
        if (['serverrack', 'holotable', 'coffee', 'pulpit'].includes(it.type)) this.drawAnim(ctx, it, t);
      } else if (e.kind === 'a') this.drawAgent(ctx, e.a, t, snap, extra);
      else this.drawDog(ctx, e.d, t);
    }
    // top-of-everything effects
    for (const f of snap.fx) this.drawFx(ctx, f, snap, t);
    this.drawNight(ctx, snap.clock);

    // screen-space overlay: names, bubbles, emotes
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawOverlay(ctx, snap, t, extra);
  }

  drawNeon(ctx, t) {
    const n = this.map.furniture.find((f) => f.type === 'neon'); if (!n) return;
    const x = n.x * T, y = n.y * T;
    ctx.fillStyle = '#0c1022'; ctx.fillRect(x, y + 4, n.w * T, 9);
    ctx.strokeStyle = '#ffd96a'; ctx.lineWidth = 0.6; ctx.strokeRect(x + 0.5, y + 4.5, n.w * T - 1, 8);
    const flick = 0.85 + 0.15 * Math.sin(t * 6) * (Math.sin(t * 0.7) > 0.95 ? 3 : 0.4);
    ctx.save(); ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = '#ff3ea5'; ctx.shadowBlur = 6 * flick; ctx.fillStyle = `rgba(255,120,200,${0.9 * flick})`;
    ctx.fillText('4EVR', x + n.w * T / 2, y + 9); ctx.shadowColor = '#5ee7ff'; ctx.shadowBlur = 3; ctx.fillStyle = `rgba(255,255,255,${0.85 * flick})`; ctx.fillText('4EVR', x + n.w * T / 2, y + 9); ctx.restore();
  }

  drawAnim(ctx, it, t) {
    const x = it.x * T, y = it.y * T;
    if (it.type === 'serverrack') {
      for (let i = 0; i < 7; i++) {
        const on = Math.sin(t * (2 + i * 0.7) + it.x * 3 + it.y) > -0.2; const col = i % 3 === 0 ? '#5ec28a' : i % 3 === 1 ? '#4ea3e0' : '#e0c24e';
        ctx.fillStyle = on ? col : '#2a3355'; ctx.fillRect(x + 11, y + 2 + i * 4, 1, 1);
        if (on) { ctx.fillStyle = col + '55'; ctx.fillRect(x + 4, y + 2 + i * 4, 6, 1); }
      }
    } else if (it.type === 'holotable') {
      const cx = x + it.w * T / 2, cy = y + it.h * T / 2 - 2;
      ctx.save(); ctx.globalAlpha = 0.5 + 0.2 * Math.sin(t * 3);
      ctx.fillStyle = '#3b8bff'; ctx.beginPath(); ctx.ellipse(cx, cy + 3, 18, 4, 0, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.85; ctx.strokeStyle = '#8fd3ff'; ctx.lineWidth = 0.7;
      for (let i = 0; i < 3; i++) { const a = t * 1.5 + i * 2.1; ctx.beginPath(); ctx.ellipse(cx, cy - 6, 11, 4, a % 3.14, 0, 7); ctx.stroke(); }
      ctx.fillStyle = '#e0f4ff'; ctx.fillRect(cx - 1, cy - 14 + Math.sin(t * 2) * 1.5, 2, 2); ctx.restore();
    } else if (it.type === 'coffee') {
      ctx.save(); ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (let i = 0; i < 3; i++) { const p = (t * 0.7 + i / 3) % 1; ctx.globalAlpha = (1 - p) * 0.6; ctx.fillRect(x + 6 + Math.sin(p * 7 + i) * 2, y - 8 - p * 8, 1.2, 1.2); }
      ctx.restore();
    } else if (it.type === 'pulpit') {
      ctx.save(); const a = 0.35 + 0.15 * Math.sin(t * 2);
      const g = ctx.createRadialGradient(x + it.w * T / 2, y - 6, 2, x + it.w * T / 2, y - 6, 26); g.addColorStop(0, `rgba(255,220,120,${a})`); g.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = g; ctx.fillRect(x - 14, y - 34, it.w * T + 28, 52);
      ctx.strokeStyle = `rgba(255,230,140,${a + 0.3})`; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.ellipse(x + it.w * T / 2, y - 12 + Math.sin(t * 2) * 1, 8, 2.4, 0, 0, 7); ctx.stroke(); ctx.restore();
    }
  }

  drawAgent(ctx, a, t, snap, extra) {
    const info = this.agentsInfo[a.id]; const look = info.look;
    let pose = a.pose, dir = a.dir;
    if ((pose === 'sit' || pose === 'type') && dir !== 'down') pose = pose === 'type' ? 'type' : 'stand';
    if (pose === 'sleep' && dir !== 'down') pose = 'stand';
    const rate = pose === 'walk' ? 9 : pose === 'type' ? 7 : pose === 'talk' ? 5 : pose === 'play' ? 4 : pose === 'drink' ? 2 : 1;
    const frame = Math.floor(t * rate + (a.id.charCodeAt(0) % 4));
    const spr = personFrame(a.id, look, dir, pose === 'sit' && dir === 'down' ? 'sit' : pose, frame % 4);
    const x = a.x * T - 8, y = a.y * T + 8 - 24;
    const sel = this.selected === a.id, hov = this.hover === a.id;
    if (sel || hov) {
      ctx.save(); ctx.strokeStyle = sel ? '#ffd96a' : '#ffffff99'; ctx.lineWidth = 0.8; ctx.setLineDash(sel ? [] : [2, 2]);
      ctx.beginPath(); ctx.ellipse(a.x * T, a.y * T + 8, 8, 3, 0, 0, 7); ctx.stroke(); ctx.restore();
    }
    ctx.drawImage(spr, x, y, 16, 24);
    // busy glow (screen light on face) for working agents
    if (a.busy && (pose === 'type' || pose === 'sit')) { ctx.save(); ctx.globalAlpha = 0.18 + 0.08 * Math.sin(t * 5); ctx.fillStyle = '#7dd3fc'; ctx.fillRect(x + 4, y + 5 + 2, 8, 6); ctx.restore(); }
  }

  drawDog(ctx, d, t) {
    const pose = d.pose; const frame = Math.floor(t * 8);
    const spr = dogFrame(d.dir, pose === 'walk' ? 'walk' : pose, frame);
    ctx.drawImage(spr, d.x * T - 8, d.y * T + 6 - 12, 16, 12);
  }

  drawFx(ctx, f, snap, t) {
    const ag = f.agent ? snap.agents.find((a) => a.id === f.agent) : null;
    const k = clamp(f.age / f.life, 0, 1);
    if (f.kind === 'sparkle' && ag) {
      ctx.save(); for (let i = 0; i < 7; i++) { const ang = i * 0.9 + t * 3; const r = 4 + k * 8; const px = ag.x * T + Math.cos(ang) * r, py = ag.y * T - 6 - k * 10 + Math.sin(ang) * r * 0.6; ctx.globalAlpha = 1 - k; ctx.fillStyle = i % 2 ? '#ffd96a' : '#fff'; ctx.fillRect(px, py, 1.5, 1.5); } ctx.restore();
    } else if (f.kind === 'confetti') {
      ctx.save(); const cols = ['#ff4d6d', '#ffd96a', '#5ec8ff', '#5ec28a', '#c084fc'];
      for (let i = 0; i < 70; i++) {
        const sd = (f.id * 131 + i * 977) % 1000 / 1000; const sd2 = (f.id * 71 + i * 313) % 1000 / 1000;
        const px = f.x * T + (sd - 0.5) * 150 + Math.sin(t * 3 + i) * 3; const py = f.y * T - 40 + k * 70 * (0.5 + sd2) + sd2 * 8;
        ctx.globalAlpha = 1 - k * k; ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(px, py, 2, 1.4);
      } ctx.restore();
    } else if (f.kind === 'halo' && ag) {
      ctx.save(); const a = 1 - k; const g = ctx.createLinearGradient(0, ag.y * T - 120, 0, ag.y * T); g.addColorStop(0, 'rgba(255,230,140,0)'); g.addColorStop(1, `rgba(255,230,140,${0.5 * a})`);
      ctx.fillStyle = g; ctx.fillRect(ag.x * T - 9, ag.y * T - 120, 18, 120);
      ctx.strokeStyle = `rgba(255,235,150,${a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(ag.x * T, ag.y * T - 20 + Math.sin(t * 4) * 1, 6, 2, 0, 0, 7); ctx.stroke(); ctx.restore();
    } else if (f.kind === 'lightning' && ag) {
      ctx.save(); const flash = f.age < 0.25 ? 1 - f.age * 4 : 0;
      if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${0.35 * flash})`; ctx.fillRect(0, 0, this.map.W * T, this.map.H * T); }
      ctx.strokeStyle = '#fff'; ctx.shadowColor = '#7dd3fc'; ctx.shadowBlur = 8; ctx.lineWidth = 1.4; ctx.globalAlpha = 1 - k;
      ctx.beginPath(); let px = ag.x * T, py = ag.y * T - 150; ctx.moveTo(px, py); const seed = f.id * 17;
      for (let i = 1; i <= 9; i++) { px = ag.x * T + (((seed * i * 37) % 11) - 5) * (i < 9 ? 1.4 : 0); py = ag.y * T - 150 + i * 16; ctx.lineTo(px, py); }
      ctx.stroke(); ctx.restore();
    }
  }

  drawNight(ctx, clock) {
    const h = clock / 60;
    const dark = Math.max(smooth(17, 21.5, h) * 0.5, (1 - smooth(5, 8.5, h)) * 0.5, 0) * (h >= 17 || h < 8.5 ? 1 : 0);
    if (dark <= 0.01) return;
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `rgba(${Math.round(255 - dark * 190)},${Math.round(255 - dark * 175)},${Math.round(255 - dark * 100)},1)`;
    ctx.fillRect(0, 0, this.map.W * T, this.map.H * T); ctx.restore();
    // neon & screens still glow at night
  }

  // -------- screen-space overlay --------
  drawOverlay(ctx, snap, t, extra) {
    const z = this.cam.zoom;
    ctx.textBaseline = 'alphabetic';
    const showAll = z >= 1.15 && this.showNames;
    const bubbles = [];
    for (const a of snap.agents) {
      const info = this.agentsInfo[a.id]; if (!info) continue;
      const p = this.worldToScreen(a.x, a.y - 1.0);
      const sit = (a.pose === 'type' || a.pose === 'sit') ? 0.12 : 0;
      const topY = p.y + sit * T * z - 4 * z;
      if (showAll || this.hover === a.id || this.selected === a.id) {
        const name = info.short; ctx.font = `600 ${clamp(9 * z * 0.72, 9, 13)}px Urbanist, system-ui, sans-serif`;
        const w = ctx.measureText(name).width + 12; const x = p.x - w / 2, y = topY - 14 - (a.emote ? 0 : 0);
        ctx.fillStyle = 'rgba(22,49,68,0.9)'; roundRect(ctx, x, y - 10, w, 14, 7); ctx.fill();
        ctx.fillStyle = info.color; ctx.beginPath(); ctx.arc(x + 6, y - 3, 2.6, 0, 7); ctx.fill();
        ctx.fillStyle = '#eef1ff'; ctx.textAlign = 'left'; ctx.fillText(name, x + 11, y + 0.5);
        if (a.busy) { ctx.fillStyle = '#5ec28a'; ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 6); ctx.beginPath(); ctx.arc(x + w - 4, y - 3, 2, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
      }
      if (a.emote) {
        const sp = emoteSprite(a.emote); const sz = clamp(9 * z * 0.9, 12, 30);
        ctx.imageSmoothingEnabled = false; ctx.drawImage(sp, p.x + 6 * z * 0.6, topY - 30 - Math.sin(t * 4) * 1.5, sz, sz);
      }
      if (a.bubble) bubbles.push({ a, p, topY, text: a.bubble.text, id: a.bubble.id });
    }
    if (snap.dog.bubble) bubbles.push({ a: { id: 'dog' }, p: this.worldToScreen(snap.dog.x, snap.dog.y - 0.8), topY: this.worldToScreen(snap.dog.x, snap.dog.y - 0.8).y, text: snap.dog.bubble, dog: true });
    // bubbles: draw selected/last first so they stack sensibly
    const placed = [];
    for (const b of bubbles) this.drawBubble(ctx, b, placed);
  }

  drawBubble(ctx, b, placed) {
    const z = this.cam.zoom; const fs = clamp(5.2 * z, 10.5, 15); ctx.font = `500 ${fs}px Urbanist, system-ui, sans-serif`;
    const maxW = clamp(46 * z, 150, 260);
    const lines = wrap(ctx, b.text, maxW);
    const shown = lines.slice(0, 5); if (lines.length > 5) shown[4] = shown[4].replace(/.{0,3}$/, '…');
    const lh = fs + 2; const w = Math.max(...shown.map((l) => ctx.measureText(l).width)) + 16; const h = shown.length * lh + 10;
    const baseX = clamp(b.p.x - w / 2, 6, this.vw - w - 6), baseY = b.topY - 34 - h;
    const hits = (x, y) => placed.some((q) => x < q.x + q.w + 4 && x + w + 4 > q.x && y < q.y + q.h + 4 && y + h + 4 > q.y);
    const cands = [[baseX, baseY]];
    for (let k = 1; k <= 3; k++) cands.push([baseX, baseY - k * (h + 6)]);
    cands.push([baseX + w + 8, baseY], [baseX - w - 8, baseY], [baseX + w + 8, baseY - h - 6], [baseX - w - 8, baseY - h - 6]);
    let x = baseX, y = baseY;
    for (const [cx, cy] of cands) {
      const nx = clamp(cx, 6, this.vw - w - 6), ny = cy;
      if (ny >= 4 && !hits(nx, ny)) { x = nx; y = ny; break; }
    }
    y = Math.max(4, y); placed.push({ x, y, w, h });
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
    ctx.fillStyle = b.dog ? '#fff7e0' : '#f7f8ff'; roundRect(ctx, x, y, w, h, 8); ctx.fill(); ctx.restore();
    ctx.fillStyle = b.dog ? '#fff7e0' : '#f7f8ff'; ctx.beginPath(); const tx = clamp(b.p.x, x + 10, x + w - 10); ctx.moveTo(tx - 5, y + h - 0.5); ctx.lineTo(tx, y + h + 6); ctx.lineTo(tx + 5, y + h - 0.5); ctx.fill();
    ctx.fillStyle = '#1b2036'; ctx.textAlign = 'left';
    shown.forEach((l, i) => ctx.fillText(l, x + 8, y + 5 + fs + i * lh - 2));
  }
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/); const lines = []; let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur); return lines;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
