// All art is drawn in code. Sprites are authored in logical pixels (1 tile = 16)
// and rasterised at S× so the world stays crisp at any zoom.
export const S = 3;
export const T = 16;

export const shade = (hex, amt) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt * (amt < 0 ? v : 255 - v))));
  const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
};

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * S); c.height = Math.ceil(h * S);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.scale(S, S);
  return { c, ctx };
}
export const rect = (ctx, x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };

// ---------------------------------------------------------------- people
// frame canvas is 16 x 24 logical px; feet on row 23
const SKIN_SHADOW = (skin) => shade(skin, -0.18);

function hair(ctx, look, dir) {
  const h = look.hair, hd = shade(h, -0.25), hl = shade(h, 0.18);
  const st = look.hairStyle;
  if (dir === 'down') {
    rect(ctx, 4, 2, 8, 3, h); rect(ctx, 3, 3, 1, 4, h); rect(ctx, 12, 3, 1, 4, h);
    if (st === 0) { rect(ctx, 4, 5, 8, 1, hd); }
    if (st === 1) { rect(ctx, 4, 5, 5, 1, h); rect(ctx, 9, 4, 3, 1, hl); }
    if (st === 2) { rect(ctx, 4, 5, 8, 1, h); rect(ctx, 3, 7, 1, 4, h); rect(ctx, 12, 7, 1, 4, h); }
    if (st === 3) { rect(ctx, 4, 5, 3, 1, h); rect(ctx, 9, 5, 3, 1, h); rect(ctx, 11, 1, 3, 3, h); }
    if (st === 4) { rect(ctx, 2, 1, 12, 4, h); rect(ctx, 2, 5, 2, 4, h); rect(ctx, 12, 5, 2, 4, h); rect(ctx, 3, 0, 10, 1, hd); }
    rect(ctx, 5, 2, 3, 1, hl);
  } else if (dir === 'up') {
    rect(ctx, 3, 2, 10, 9, h); rect(ctx, 4, 1, 8, 1, h);
    if (st === 2) rect(ctx, 3, 11, 10, 2, h);
    if (st === 3) rect(ctx, 6, 11, 4, 3, h);
    if (st === 4) { rect(ctx, 2, 1, 12, 10, h); rect(ctx, 3, 0, 10, 1, hd); }
    rect(ctx, 5, 3, 3, 1, hl);
  } else { // side (drawn facing right; mirrored for left)
    rect(ctx, 4, 2, 8, 3, h); rect(ctx, 3, 3, 3, 7, h);
    if (st === 2) rect(ctx, 3, 9, 3, 3, h);
    if (st === 3) rect(ctx, 2, 4, 3, 5, h);
    if (st === 4) { rect(ctx, 2, 1, 10, 5, h); rect(ctx, 2, 5, 4, 5, h); }
    if (st === 1) rect(ctx, 10, 4, 2, 1, hl);
    rect(ctx, 6, 2, 3, 1, hl);
  }
}

function extras(ctx, look, dir) {
  const e = look.extra;
  if (e === 'glasses') {
    if (dir === 'down') { rect(ctx, 5, 6, 3, 2, '#1b1b25'); rect(ctx, 8, 6, 3, 2, '#1b1b25'); rect(ctx, 6, 7, 1, 1, '#a9d6ff'); rect(ctx, 9, 7, 1, 1, '#a9d6ff'); rect(ctx, 8, 6, 0, 0, '#1b1b25'); }
    if (dir === 'right') { rect(ctx, 8, 6, 3, 2, '#1b1b25'); rect(ctx, 9, 7, 1, 1, '#a9d6ff'); }
  }
  if (e === 'beanie') {
    const c = '#e11d48';
    if (dir === 'down') { rect(ctx, 3, 1, 10, 4, c); rect(ctx, 3, 4, 10, 1, shade(c, -0.25)); rect(ctx, 7, 0, 2, 1, '#fff'); }
    else if (dir === 'up') { rect(ctx, 3, 1, 10, 6, c); rect(ctx, 7, 0, 2, 1, '#fff'); }
    else { rect(ctx, 3, 1, 9, 4, c); rect(ctx, 3, 4, 9, 1, shade(c, -0.25)); rect(ctx, 6, 0, 2, 1, '#fff'); }
  }
  if (e === 'headband') {
    const c = '#f43f5e';
    if (dir === 'down') rect(ctx, 3, 4, 10, 1, c);
    else if (dir === 'up') rect(ctx, 3, 4, 10, 1, c);
    else rect(ctx, 3, 4, 8, 1, c);
  }
}

function drawPerson(ctx, look, dir, pose, frame) {
  const skin = look.skin, sh = SKIN_SHADOW(skin), shirt = look.shirt, pants = look.pants;
  const shirtD = shade(shirt, -0.25), shirtL = shade(shirt, 0.15);
  let bob = 0;
  if (pose === 'stand' || pose === 'talk') bob = frame % 2 === 1 ? 0 : 0;
  const mirror = dir === 'left';
  const d = dir === 'left' ? 'right' : dir;
  if (mirror) { ctx.save(); ctx.translate(16, 0); ctx.scale(-1, 1); }
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(3, 22, 10, 2);

  const walking = pose === 'walk';
  const step = walking ? frame % 4 : 0;
  const legA = walking ? [0, -1, 0, 1][step] : 0; // left leg lift
  const legB = walking ? [0, 1, 0, -1][step] : 0;
  const bounce = walking && (step === 1 || step === 3) ? -1 : 0;
  const sitting = pose === 'sit' || pose === 'type' || pose === 'sleep' && d === 'down';

  if (d === 'down' || d === 'up') {
    const oy = bounce + (sitting ? 2 : 0);
    ctx.save(); ctx.translate(0, oy);
    // legs
    if (!sitting) {
      rect(ctx, 5, 18 + legA, 3, 5 - legA, pants); rect(ctx, 8, 18 + legB, 3, 5 - legB, pants);
      rect(ctx, 5, 22 + 0, 3, 1, '#17171f'); rect(ctx, 8, 22, 3, 1, '#17171f');
    } else {
      rect(ctx, 5, 18, 6, 4, pants);
    }
    // torso
    rect(ctx, 4, 11, 8, 7, shirt); rect(ctx, 4, 16, 8, 2, shirtD); rect(ctx, 5, 11, 2, 1, shirtL);
    if (look.extra === 'tie' && d === 'down') { rect(ctx, 7, 11, 2, 1, '#f1f1f1'); rect(ctx, 7, 12, 2, 4, '#7f1d1d'); }
    // arms
    let armL = 0, armR = 0;
    if (walking) { armL = [0, 1, 0, -1][step]; armR = -armL; }
    if (pose === 'type' && d === 'down') {
      const k = frame % 2; rect(ctx, 3, 12, 1, 4, shirtD); rect(ctx, 12, 12, 1, 4, shirtD);
      rect(ctx, 4, 16, 2, 1, skin); rect(ctx, 10, 16 - k, 2, 1, skin); rect(ctx, 6, 16 + k, 1, 1, skin);
    } else if (pose === 'drink' && d === 'down') {
      rect(ctx, 3, 12, 1, 5, shirtD); rect(ctx, 12, 9, 1, 5, shirtD); rect(ctx, 12, 8, 1, 1, skin);
      rect(ctx, 12, 6, 3, 3, '#f5f5f5'); rect(ctx, 13, 7, 1, 1, '#7c4a2a'); rect(ctx, 15, 7, 1, 1, '#f5f5f5');
    } else if (pose === 'talk' && d === 'down') {
      const up = frame % 2; rect(ctx, 3, 12, 1, 5, shirtD); rect(ctx, 12, up ? 10 : 12, 1, up ? 4 : 5, shirtD); rect(ctx, 12, up ? 9 : 16, 1, 1, skin);
    } else if (pose === 'play') {
      const sw = frame % 2; rect(ctx, 3, 12, 1, 5, shirtD); rect(ctx, 12, sw ? 10 : 13, 1, 4, shirtD); rect(ctx, 13, sw ? 8 : 12, 3, 2, '#d33'); rect(ctx, 12, sw ? 9 : 16, 1, 1, skin);
    } else {
      rect(ctx, 3, 12 + armL, 1, 5, shirtD); rect(ctx, 12, 12 + armR, 1, 5, shirtD);
      rect(ctx, 3, 17 + armL, 1, 1, skin); rect(ctx, 12, 17 + armR, 1, 1, skin);
    }
    // head
    rect(ctx, 4, 3, 8, 8, skin); rect(ctx, 4, 10, 8, 1, sh);
    if (d === 'down') {
      const closed = pose === 'sleep';
      if (closed) { rect(ctx, 5, 7, 2, 1, '#2b2b36'); rect(ctx, 9, 7, 2, 1, '#2b2b36'); }
      else { rect(ctx, 6, 7, 1, 2, '#1b1b25'); rect(ctx, 9, 7, 1, 2, '#1b1b25'); }
      if (pose === 'talk' && frame % 2) rect(ctx, 7, 9, 2, 1, '#7a2e2e'); else rect(ctx, 7, 9, 2, 1, sh);
      rect(ctx, 4, 8, 1, 1, shade('#ff7a7a', 0.2)); rect(ctx, 11, 8, 1, 1, shade('#ff7a7a', 0.2));
      hair(ctx, look, 'down');
    } else {
      rect(ctx, 4, 3, 8, 8, look.hair); hair(ctx, look, 'up');
    }
    extras(ctx, look, d);
    ctx.restore();
  } else {
    // side view, facing right
    const oy = bounce;
    ctx.save(); ctx.translate(0, oy);
    rect(ctx, 6, 18 + legA, 3, 5 - legA, pants); rect(ctx, 7, 18 + legB, 3, 5 - legB, shade(pants, -0.2));
    rect(ctx, 6, 22, 4, 1, '#17171f');
    rect(ctx, 5, 11, 6, 7, shirt); rect(ctx, 5, 16, 6, 2, shirtD);
    const sw = walking ? [0, 1, 0, -1][step] : 0;
    if (pose === 'drink') { rect(ctx, 9, 11, 3, 2, shirtD); rect(ctx, 11, 8, 1, 4, shirtD); rect(ctx, 11, 6, 3, 3, '#f5f5f5'); rect(ctx, 12, 7, 1, 1, '#7c4a2a'); }
    else if (pose === 'play') { const k = frame % 2; rect(ctx, 9, 12, 3, 2, shirtD); rect(ctx, 11, k ? 9 : 13, 1, 4, shirtD); rect(ctx, 12, k ? 7 : 12, 3, 2, '#d33'); }
    else if (pose === 'type') { rect(ctx, 9, 13, 3, 2, shirtD); rect(ctx, 11, 12 + (frame % 2), 1, 2, skin); }
    else rect(ctx, 7 + sw, 12, 2, 5, shirtD);
    rect(ctx, 4, 3, 8, 8, skin); rect(ctx, 4, 10, 7, 1, sh);
    rect(ctx, 10, 6, 1, 2, '#1b1b25'); rect(ctx, 11, 8, 1, 1, sh);
    if (pose === 'talk' && frame % 2) rect(ctx, 10, 9, 2, 1, '#7a2e2e');
    hair(ctx, look, 'right');
    extras(ctx, look, 'right');
    ctx.restore();
  }
  if (mirror) ctx.restore();
}

const personCache = new Map();
export function personFrame(agentId, look, dir, pose, frame) {
  const key = `${agentId}|${dir}|${pose}|${frame}`;
  let hit = personCache.get(key);
  if (!hit) {
    const { c, ctx } = makeCanvas(16, 24);
    drawPerson(ctx, look, dir, pose, frame);
    personCache.set(key, c); hit = c;
  }
  return hit;
}

// ---------------------------------------------------------------- Pixel the dog
const dogCache = new Map();
export function dogFrame(dir, pose, frame) {
  const key = `${dir}|${pose}|${frame}`;
  let hit = dogCache.get(key);
  if (hit) return hit;
  const { c, ctx } = makeCanvas(16, 12);
  const body = '#c98a4b', dark = '#8a5a2b', light = '#f0d2a6';
  const mirror = dir === 'left';
  if (mirror) { ctx.translate(16, 0); ctx.scale(-1, 1); }
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(2, 10, 12, 2);
  const f = frame % 2;
  if (dir === 'up' || dir === 'down') {
    rect(ctx, 4, 4, 8, 6, body); rect(ctx, 5, 1, 6, 5, body); rect(ctx, 4, 1, 2, 3, dark); rect(ctx, 10, 1, 2, 3, dark);
    if (dir === 'down') { rect(ctx, 6, 3, 1, 1, '#111'); rect(ctx, 9, 3, 1, 1, '#111'); rect(ctx, 7, 4, 2, 2, light); rect(ctx, 7, 4, 2, 1, '#111'); }
    rect(ctx, 5, 9 + (pose === 'walk' ? f : 0), 2, 2, dark); rect(ctx, 9, 9 + (pose === 'walk' ? 1 - f : 0), 2, 2, dark);
  } else {
    rect(ctx, 2, 4, 9, 5, body); rect(ctx, 9, 2, 5, 5, body); rect(ctx, 8, 2, 2, 4, dark); rect(ctx, 13, 4, 2, 2, light); rect(ctx, 14, 4, 1, 1, '#111'); rect(ctx, 11, 3, 1, 1, '#111');
    rect(ctx, 0, 3 - (f && pose !== 'sit' ? 1 : 0), 3, 2, dark);
    if (pose === 'sit') { rect(ctx, 3, 8, 3, 3, dark); rect(ctx, 9, 8, 2, 3, dark); }
    else { const a = pose === 'walk' ? f : 0; rect(ctx, 3 + a, 8, 2, 3, dark); rect(ctx, 9 - a, 8, 2, 3, dark); rect(ctx, 5 - a, 8, 2, 3, body); rect(ctx, 7 + a, 8, 2, 3, body); }
  }
  dogCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------- emotes
const EMOTES = {
  bulb: ['..yyy..', '.yyyyy.', '.yywyy.', '.yyyyy.', '..ggg..', '..ggg..', '...g...'],
  heart: ['.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...', '.......'],
  coffee: ['..w.w..', '.w.w...', 'wwwwww.', 'wbbbbww', 'wbbbbw.', '.wwww..', '.......'],
  exclaim: ['..rrr..', '..rrr..', '..rrr..', '..rrr..', '.......', '..rrr..', '..rrr..'],
  question: ['.bbbbb.', 'bb...bb', '.....bb', '...bbb.', '..bb...', '.......', '..bb...'],
  star: ['...y...', '...y...', 'yyyyyyy', '.yyyyy.', '..yyy..', '.yy.yy.', '.y...y.'],
  dots: ['.......', '.......', 'w.w.w..', '.......', '.......', '.......', '.......'],
  zzz: ['wwww...', '..w....', '.w..www', 'wwww..w', '.....w.', '....www', '.......'],
  book: ['.bbbbb.', 'bwwbwwb', 'bwwbwwb', 'bwwbwwb', 'bwwbwwb', '.bbbbb.', '.......'],
  magnifier: ['.bbb...', 'b...b..', 'b...b..', 'b...b..', '.bbbb..', '....bb.', '.....bb'],
};
const EMO_COL = { y: '#ffd84a', w: '#ffffff', g: '#9aa3b2', r: '#ff4d6d', b: '#5ec8ff', '.': null };
const emoteCache = new Map();
export function emoteSprite(name) {
  let c = emoteCache.get(name); if (c) return c;
  const pat = EMOTES[name] || EMOTES.star;
  const { c: cv, ctx } = makeCanvas(9, 9);
  rect(ctx, 0, 0, 9, 8, 'rgba(15,18,32,0.82)');
  rect(ctx, 3, 8, 3, 1, 'rgba(15,18,32,0.82)');
  pat.forEach((row, y) => [...row].forEach((ch, x) => { if (EMO_COL[ch]) rect(ctx, 1 + x, 0 + y, 1, 1, EMO_COL[ch]); }));
  emoteCache.set(name, cv); return cv;
}

// ---------------------------------------------------------------- floors & walls
export const FLOORS = {
  wood: ['#b98b5a', '#aa7d4f', '#8f6640'],
  teal: ['#2f7478', '#2a6c70', '#225a5e'],
  violet: ['#5e4392', '#573d8a', '#46316f'],
  blue: ['#33629f', '#2e5a96', '#264b7c'],
  green: ['#3c8050', '#377849', '#2c6339'],
  amber: ['#b98340', '#ad7a38', '#8f6430'],
  vault: ['#1c2336', '#192032', '#2a3a5a'],
  hub: ['#d2cbb9', '#c6bfad', '#aaa391'],
  lounge: ['#7e6c8c', '#766584', '#5f4f6b'],
  annex: ['#52657d', '#4a5c73', '#3a4a5f'],
  people: ['#6b8f7a', '#648a73', '#4f7260'],
  door: ['#4a4f5c', '#454a56', '#363a45'],
};

export function drawFloorTile(ctx, style, tx, ty) {
  const [a, b, line] = FLOORS[style] || FLOORS.hub;
  const x = tx * T, y = ty * T;
  const alt = (tx + ty) % 2 === 0;
  rect(ctx, x, y, T, T, alt ? a : b);
  if (style === 'wood' || style === 'amber') { rect(ctx, x, y + 5, T, 1, line); rect(ctx, x, y + 11, T, 1, line); rect(ctx, x + ((tx * 7 + ty * 3) % 12), y, 1, 5, line); rect(ctx, x + ((tx * 5 + ty * 11) % 12), y + 6, 1, 5, line); }
  else if (style === 'vault') { rect(ctx, x, y, T, 1, line); rect(ctx, x, y, 1, T, line); if ((tx + ty * 3) % 5 === 0) rect(ctx, x + 7, y + 7, 2, 2, '#3b6bff55'); }
  else if (style === 'hub') { rect(ctx, x, y, T, 1, line); rect(ctx, x, y, 1, T, line); }
  else if (style === 'door') { rect(ctx, x, y + 7, T, 2, '#f5c542'); }
  else { if ((tx * 13 + ty * 7) % 6 === 0) rect(ctx, x + 4, y + 4, 2, 2, line); if ((tx * 5 + ty * 17) % 7 === 0) rect(ctx, x + 10, y + 10, 2, 1, line); }
}

export function drawWallTile(ctx, tx, ty, below, mapWall) {
  const x = tx * T, y = ty * T;
  const cap = '#1e2338', capL = '#343b5c', face = '#4d5578', faceD = '#414870', brick = '#3a4166';
  const wallBelow = ty + 1 < mapWall.length && mapWall[ty + 1][tx];
  if (wallBelow || !below) {
    rect(ctx, x, y, T, T, cap); rect(ctx, x + 1, y + 1, T - 2, T - 2, capL);
    rect(ctx, x + 1, y + 1, T - 2, 2, shade(capL, 0.12));
  } else {
    rect(ctx, x, y, T, 5, cap); rect(ctx, x, y + 1, T, 1, capL);
    rect(ctx, x, y + 5, T, 11, face);
    for (let r = 0; r < 3; r++) { rect(ctx, x, y + 8 + r * 4, T, 1, brick); const off = r % 2 ? 4 : 10; rect(ctx, x + off, y + 5 + r * 4, 1, 4, brick); }
    rect(ctx, x, y + 14, T, 2, faceD);
  }
}
