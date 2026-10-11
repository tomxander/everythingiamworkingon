// The 4EVR headquarters. 48x31 tiles, 16px each. Everything here is data;
// the client turns it into pixel art.

export const TILE = 16;
export const W = 48;
export const H = 31;

const ROOMS = [
  // row A (doors on the bottom wall, facing the hub)
  { id: 'strategy', name: 'The War Room', x: 0, y: 0, w: 16, h: 11, floor: 'wood', doors: ['bottom'] },
  { id: 'seo', name: 'SEO & Content Lab', x: 15, y: 0, w: 17, h: 11, floor: 'teal', doors: ['bottom'] },
  { id: 'creative', name: 'Creative Studio', x: 31, y: 0, w: 17, h: 11, floor: 'violet', doors: ['bottom'] },
  // row B (doors top + bottom)
  { id: 'growth', name: 'Growth & Data Lab', x: 0, y: 15, w: 13, h: 10, floor: 'blue', doors: ['top', 'bottom'] },
  { id: 'lifecycle', name: 'Lifecycle & Paid', x: 12, y: 15, w: 13, h: 10, floor: 'green', doors: ['top', 'bottom'] },
  { id: 'revenue', name: 'Revenue & Reach', x: 24, y: 15, w: 13, h: 10, floor: 'amber', doors: ['top', 'bottom'] },
  { id: 'vault', name: 'The Skill Vault', x: 36, y: 15, w: 12, h: 10, floor: 'vault', doors: ['top', 'bottom'] },
  // bottom lounge
  { id: 'lounge', name: 'The Lounge', x: 0, y: 24, w: 48, h: 7, floor: 'lounge', doors: ['top'] },
];

const HUB = { id: 'hub', name: 'Town Hall', x: 1, y: 11, w: 46, h: 4, floor: 'hub' };

export function buildMap() {
  const floor = Array.from({ length: H }, () => Array(W).fill(null));
  const wall = Array.from({ length: H }, () => Array(W).fill(false));
  const furniture = [];
  const spots = {}; // named places agents can walk to
  const desks = {}; // roomId -> [{ desk, seat }]

  const f = (type, x, y, w = 1, h = 1, extra = {}) => {
    const item = { type, x, y, w, h, blocks: true, ...extra };
    furniture.push(item);
    return item;
  };
  const deco = (type, x, y, w = 1, h = 1, extra = {}) => f(type, x, y, w, h, { blocks: false, ...extra });

  // floors + walls
  for (const r of ROOMS) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const edge = y === r.y || y === r.y + r.h - 1 || x === r.x || x === r.x + r.w - 1;
        if (edge) wall[y][x] = true;
        else floor[y][x] = r.floor;
      }
    }
  }
  for (let y = HUB.y; y < HUB.y + HUB.h; y++) for (let x = HUB.x; x < HUB.x + HUB.w; x++) { floor[y][x] = 'hub'; wall[y][x] = false; }
  // outer walls of hub ends
  for (let y = HUB.y; y < HUB.y + HUB.h; y++) { wall[y][0] = true; wall[y][W - 1] = true; }

  // doors (2 wide, centered) – carve through walls
  const carve = (x, y) => { wall[y][x] = false; floor[y][x] = floor[y][x] || 'hub'; };
  const doorSpots = {};
  for (const r of ROOMS) {
    const cx = r.x + Math.floor(r.w / 2);
    for (const d of r.doors) {
      const y = d === 'bottom' ? r.y + r.h - 1 : r.y;
      carve(cx - 1, y); carve(cx, y);
      floor[y][cx - 1] = r.floor === 'lounge' ? 'lounge' : 'door';
      floor[y][cx] = r.floor === 'lounge' ? 'lounge' : 'door';
      doorSpots[`${r.id}:${d}`] = { x: cx, y };
    }
  }
  // the lounge top wall sits at y=24 which is also the bottom wall of row B: doors for both already carved.
  // wall between row B and lounge shares y=24 — make sure the lounge floor shows through lounge doors
  // (handled above)

  const interior = (r) => ({ ix: r.x + 1, iy: r.y + 1, iw: r.w - 2, ih: r.h - 2 });
  const room = Object.fromEntries(ROOMS.map((r) => [r.id, r]));

  // ---------- desks ----------
  const placeDesks = (id, count, rowOffset, opts = {}) => {
    const r = room[id]; const { ix, iy } = interior(r);
    desks[id] = [];
    const startX = opts.startX ?? ix + 1;
    for (let k = 0; k < count; k++) {
      const dx = startX + k * 4; const dy = iy + rowOffset;
      const desk = f('desk', dx, dy, 2, 1, { room: id, variant: k % 3 });
      f('monitor', dx, dy, 2, 1, { blocks: false, room: id });
      deco('chair', dx, dy - 1, 1, 1);
      desks[id].push({
        desk,
        // the agent sits north of the desk, facing the camera; the desk hides their legs
        seat: { tx: dx, ty: dy - 1, x: dx + 1.0, y: dy - 0.5, dir: 'down' },
        visit: { tx: dx + 2, ty: dy - 1 },
      });
    }
  };

  // ---------- room dressing ----------
  // Strategy: council table + whiteboards + bookshelves
  {
    const r = room.strategy; const { ix, iy, iw } = interior(r);
    placeDesks('strategy', 3, 2, { startX: ix + 1 });
    for (let i = 0; i < 3; i++) deco('bookshelf', ix + i * 4 + 1, iy, 2, 1);
    deco('whiteboard', ix + 12, iy, 2, 1, { text: 'GO-TO-MARKET' });
    // council table
    const tx = ix + 4, ty = iy + 6;
    f('roundtable', tx, ty, 6, 2);
    spots.council = [];
    for (let i = 0; i < 6; i++) {
      const cx = tx + i; spots.council.push({ x: cx + 0.5, y: ty - 0.4, tx: cx, ty: ty - 1, dir: 'down' });
    }
    for (let i = 0; i < 6; i++) { const cx = tx + i; spots.council.push({ x: cx + 0.5, y: ty + 2.6, tx: cx, ty: ty + 2, dir: 'up' }); }
    for (let i = 0; i < 6; i++) deco('chair', tx + i, ty - 1), deco('chair', tx + i, ty + 2);
    deco('plant', ix + iw - 1, iy + 6); deco('plant', ix, iy + 6);
    deco('rug', ix + 3, iy + 5, 8, 5, { color: 'warm' });
    spots.whiteboard_strategy = { tx: ix + 12, ty: iy + 1 };
  }
  // SEO lab
  {
    const r = room.seo; const { ix, iy, iw } = interior(r);
    placeDesks('seo', 2, 2, { startX: ix + 1 });
    deco('whiteboard', ix + 10, iy, 3, 1, { text: 'SERP MAP' });
    deco('bookshelf', ix, iy, 2, 1); deco('bookshelf', ix + 4, iy, 2, 1);
    f('serverrack', ix + iw - 2, iy + 1, 1, 2); f('serverrack', ix + iw - 1, iy + 1, 1, 2);
    f('table', ix + 2, iy + 6, 3, 2); deco('chair', ix + 2, iy + 5); deco('chair', ix + 4, iy + 5); deco('chair', ix + 3, iy + 8);
    f('couch', ix + 9, iy + 6, 3, 1, { dirOut: 'down' });
    deco('plant', ix + iw - 1, iy + 7); deco('rug', ix + 8, iy + 5, 5, 4, { color: 'teal' });
    spots.whiteboard_seo = { tx: ix + 11, ty: iy + 1 };
  }
  // Creative studio
  {
    const r = room.creative; const { ix, iy, iw } = interior(r);
    placeDesks('creative', 3, 2, { startX: ix + 1 });
    deco('whiteboard', ix + 12, iy, 3, 1, { text: 'MOODBOARD' });
    deco('poster', ix, iy, 1, 1, { variant: 0 }); deco('poster', ix + 6, iy, 1, 1, { variant: 1 }); deco('poster', ix + 8, iy, 1, 1, { variant: 2 });
    f('easel', ix + 1, iy + 6, 1, 2); f('easel', ix + 4, iy + 6, 1, 2);
    f('couch', ix + 9, iy + 7, 4, 1, { dirOut: 'up' });
    deco('rug', ix + 8, iy + 5, 6, 4, { color: 'violet' });
    deco('plant', ix + iw - 1, iy + 6); deco('plant', ix + 7, iy + 7);
    spots.whiteboard_creative = { tx: ix + 13, ty: iy + 1 };
  }
  // Growth & Data
  {
    const r = room.growth; const { ix, iy, iw } = interior(r);
    placeDesks('growth', 2, 3, { startX: ix + 1 });
    deco('whiteboard', ix + 1, iy, 3, 1, { text: 'FUNNEL' });
    deco('whiteboard', ix + 6, iy, 3, 1, { text: 'A/B  p<.05' });
    deco('chart', ix + 9, iy, 2, 1);
    f('table', ix + 4, iy + 6, 3, 1); deco('plant', ix + iw - 1, iy + 6); deco('plant', ix, iy + 6);
    spots.whiteboard_growth = { tx: ix + 2, ty: iy + 1 };
  }
  // Lifecycle & Paid
  {
    const r = room.lifecycle; const { ix, iy, iw } = interior(r);
    placeDesks('lifecycle', 2, 3, { startX: ix + 1 });
    deco('whiteboard', ix + 1, iy, 3, 1, { text: 'FLOWS' });
    deco('poster', ix + 6, iy, 1, 1, { variant: 1 }); deco('chart', ix + 8, iy, 2, 1);
    f('printer', ix + iw - 1, iy + 1, 1, 1);
    f('couch', ix + 2, iy + 7, 3, 1, { dirOut: 'up' }); deco('plant', ix + iw - 1, iy + 7);
    spots.whiteboard_lifecycle = { tx: ix + 2, ty: iy + 1 };
  }
  // Revenue & Reach
  {
    const r = room.revenue; const { ix, iy, iw } = interior(r);
    placeDesks('revenue', 2, 3, { startX: ix + 1 });
    deco('whiteboard', ix + 1, iy, 3, 1, { text: 'PIPELINE' });
    deco('poster', ix + 6, iy, 1, 1, { variant: 2 }); deco('poster', ix + 8, iy, 1, 1, { variant: 0 });
    f('phone', ix + 8, iy + 5, 1, 1);
    deco('plant', ix + iw - 1, iy + 7); deco('plant', ix, iy + 7);
    f('table', ix + 4, iy + 6, 3, 1);
    spots.whiteboard_revenue = { tx: ix + 2, ty: iy + 1 };
  }
  // Skill Vault: glowing server racks + a holo-table in the middle
  {
    const r = room.vault; const { ix, iy, iw, ih } = interior(r);
    for (let i = 0; i < 5; i++) f('serverrack', ix + 1 + i * 2, iy, 1, 2, { glow: true });
    for (let i = 0; i < 5; i++) f('serverrack', ix + 1 + i * 2, iy + ih - 2, 1, 2, { glow: true });
    f('holotable', ix + 3, iy + 3, 4, 2);
    spots.vault = [
      { tx: ix + 2, ty: iy + 3, x: ix + 2.5, y: iy + 3.6, dir: 'right' },
      { tx: ix + 7, ty: iy + 3, x: ix + 7.5, y: iy + 3.6, dir: 'left' },
      { tx: ix + 4, ty: iy + 5, x: ix + 4.5, y: iy + 5.6, dir: 'up' },
      { tx: ix + 5, ty: iy + 2, x: ix + 5.5, y: iy + 2.6, dir: 'down' },
    ];
    deco('plant', ix + iw - 1, iy + 4);
  }
  // Hub: God's pulpit + reception + water cooler + benches
  {
    const cx = 24;
    f('pulpit', cx - 1, 12, 2, 1);
    deco('rug', cx - 6, 11, 12, 4, { color: 'gold' });
    deco('logo_floor', cx - 3, 13, 6, 1);
    spots.pulpit = { tx: cx - 1, ty: 13, x: cx, y: 13.5 };
    spots.townhall = [];
    for (let i = 0; i < 12; i++) {
      const ang = Math.PI * (0.1 + 0.8 * (i / 11));
      const tx = Math.round(cx + Math.cos(ang) * 7.5 - 0.5 * 0);
      const ty = Math.round(12.5 + Math.sin(ang) * 1.9);
      spots.townhall.push({ tx: Math.min(45, Math.max(2, tx)), ty: Math.min(14, Math.max(11, ty)) });
    }
    // simpler, robust townhall slots: a double row
    spots.townhall = [];
    for (let i = 0; i < 8; i++) spots.townhall.push({ tx: cx - 7 + i * 2, ty: 14 });
    for (let i = 0; i < 6; i++) spots.townhall.push({ tx: cx - 5 + i * 2, ty: 11 });
    f('reception', 3, 12, 4, 1); deco('plant', 2, 11); deco('plant', 7, 11);
    f('watercooler', 41, 11, 1, 1); deco('plant', 44, 11); deco('plant', 44, 14); deco('plant', 2, 14);
    deco('bench', 11, 14, 3, 1); deco('bench', 34, 14, 3, 1);
    spots.watercooler = { tx: 41, ty: 12 };
    spots.reception = { tx: 4, ty: 13 };
  }
  // Lounge: kitchen, coffee, couches, ping pong
  {
    const r = room.lounge; const { ix, iy, iw, ih } = interior(r);
    f('counter', ix + 1, iy, 8, 1); f('coffee', ix + 2, iy, 1, 1); f('fridge', ix + 9, iy, 1, 2);
    f('vending', ix + 11, iy, 1, 2);
    spots.coffee = { tx: ix + 2, ty: iy + 1 };
    spots.kitchen = [{ tx: ix + 4, ty: iy + 1 }, { tx: ix + 6, ty: iy + 1 }];
    f('table', ix + 14, iy + 1, 3, 2); deco('chair', ix + 14, iy + 3); deco('chair', ix + 16, iy + 3); deco('chair', ix + 13, iy + 1); deco('chair', ix + 17, iy + 1);
    f('pingpong', ix + 22, iy + 1, 4, 2);
    spots.pingpong = [{ tx: ix + 21, ty: iy + 1 }, { tx: ix + 26, ty: iy + 2 }];
    f('couch', ix + 31, iy + 1, 4, 1, { dirOut: 'down' });
    f('couch', ix + 31, iy + 4, 4, 1, { dirOut: 'up' });
    f('coffeetable', ix + 32, iy + 2, 2, 1);
    deco('rug', ix + 30, iy + 1, 6, 5, { color: 'warm' });
    // approach tile + final position on the cushion
    spots.couch = [
      { tx: ix + 31, ty: iy + 2, x: ix + 31.5, y: iy + 1.45, dir: 'down' },
      { tx: ix + 34, ty: iy + 2, x: ix + 34.5, y: iy + 1.45, dir: 'down' },
      { tx: ix + 31, ty: iy + 3, x: ix + 31.5, y: iy + 4.45, dir: 'up' },
      { tx: ix + 34, ty: iy + 3, x: ix + 34.5, y: iy + 4.45, dir: 'up' },
    ];
    f('beanbag', ix + 39, iy + 1, 1, 1, { color: '#e05d7a' }); f('beanbag', ix + 41, iy + 2, 1, 1, { color: '#4ea3e0' }); f('beanbag', ix + 40, iy + 4, 1, 1, { color: '#e0c24e' });
    spots.beanbag = [{ tx: ix + 39, ty: iy + 2 }, { tx: ix + 41, ty: iy + 3 }, { tx: ix + 40, ty: iy + 5 }];
    deco('plant', ix + iw - 1, iy + ih - 1); deco('plant', ix, iy + ih - 1); deco('plant', ix + 18, iy + ih - 1);
    deco('window', ix + 12, iy, 2, 1);
    spots.dogbed = { tx: ix + 19, ty: iy + 4 };
    deco('dogbed', ix + 19, iy + 3, 2, 1);
  }

  // walls: windows + brand
  deco('neon', 20, 10, 8, 1, { text: '4EVR', onWall: true });

  // ---------- walkability ----------
  const walk = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => !!floor[y][x] && !wall[y][x]));
  for (const it of furniture) {
    if (!it.blocks) continue;
    for (let yy = it.y; yy < it.y + it.h; yy++) for (let xx = it.x; xx < it.x + it.w; xx++) {
      if (yy >= 0 && yy < H && xx >= 0 && xx < W) walk[yy][xx] = false;
    }
  }
  // hub doors area etc. keep desks' seat tiles walkable
  for (const list of Object.values(desks)) for (const d of list) walk[d.seat.ty][d.seat.tx] = true;
  for (const lst of [spots.council, spots.vault]) for (const s of lst) { if (!walk[s.ty][s.tx]) walk[s.ty][s.tx] = true; }

  // fix up single-tile spots that landed on blocked tiles by nudging to nearest walkable tile
  const nudge = (s) => {
    if (walk[s.ty]?.[s.tx]) return s;
    for (let r = 1; r < 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (walk[s.ty + dy]?.[s.tx + dx]) return { ...s, tx: s.tx + dx, ty: s.ty + dy };
    }
    return s;
  };
  for (const k of Object.keys(spots)) {
    if (Array.isArray(spots[k])) spots[k] = spots[k].map(nudge); else if (spots[k].tx !== undefined) spots[k] = nudge(spots[k]);
  }
  for (const list of Object.values(desks)) for (const d of list) d.visit = nudge(d.visit);

  return { TILE, W, H, rooms: [...ROOMS, HUB], floor, wall, furniture, spots, desks, walk, doorSpots };
}

// ---------- A* (8-directional, no corner cutting) ----------
export function findPath(walk, from, to) {
  const H_ = walk.length, W_ = walk[0].length;
  const sx = from.tx, sy = from.ty, gx = to.tx, gy = to.ty;
  if (!walk[gy]?.[gx]) return null;
  if (sx === gx && sy === gy) return [];
  const key = (x, y) => y * W_ + x;
  const open = new Map(); const closed = new Set(); const came = new Map(); const g = new Map();
  const heap = [];
  const push = (n) => { heap.push(n); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const h = (x, y) => { const dx = Math.abs(x - gx), dy = Math.abs(y - gy); return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy); };
  g.set(key(sx, sy), 0); push({ x: sx, y: sy, f: h(sx, sy) });
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.length) {
    const cur = pop(); const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    if (cur.x === gx && cur.y === gy) {
      const path = []; let k = ck;
      while (k !== key(sx, sy)) { path.push({ tx: k % W_, ty: Math.floor(k / W_) }); k = came.get(k); }
      return path.reverse();
    }
    closed.add(ck);
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= W_ || ny >= H_ || !walk[ny][nx]) continue;
      if (dx && dy && (!walk[cur.y][nx] || !walk[ny][cur.x])) continue;
      const nk = key(nx, ny); if (closed.has(nk)) continue;
      const ng = g.get(ck) + (dx && dy ? Math.SQRT2 : 1);
      if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); came.set(nk, ck); push({ x: nx, y: ny, f: ng + h(nx, ny) }); }
    }
  }
  return null;
}
