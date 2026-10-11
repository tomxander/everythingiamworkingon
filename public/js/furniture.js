import { S, T, makeCanvas, rect, shade } from './sprites.js';

const MARGIN = 16; // extra pixels above each furniture sprite (things are taller than their footprint)
export const FLAT = new Set(['rug', 'logo_floor', 'dogbed']);
export const WALL = new Set(['whiteboard', 'poster', 'chart', 'window']);

const hashStr = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
const WOOD = ['#c9a06a', '#d8d8e2', '#8a93a6'];
const BOOKS = ['#e05d7a', '#4ea3e0', '#e0c24e', '#5ec28a', '#a67ce0', '#e0884e', '#d8d8e2'];
const RUG = {
  warm: ['#8b3a3a', '#a64a4a', '#e8c37a'], teal: ['#1d5f66', '#27777f', '#9fe1d8'], violet: ['#4a3178', '#5e4392', '#d6c4ff'], gold: ['#7a5b1a', '#9b7524', '#ffd96a'],
};

function drawers(it) {
  const h = Math.abs(hashStr(`${it.type}${it.x}${it.y}`));
  const W = it.w * T, H = it.h * T;
  return {
    desk(ctx) {
      const top = WOOD[it.variant % WOOD.length];
      // monitor back
      rect(ctx, 11, -9, 10, 8, '#262a3a'); rect(ctx, 12, -8, 8, 6, '#323850'); rect(ctx, 15, -1, 2, 3, '#1a1d2a'); rect(ctx, 14, 2, 4, 1, '#1a1d2a');
      rect(ctx, 15, -6, 2, 2, '#4a5170');
      // desk top & front
      rect(ctx, 0, 3, W, 9, top); rect(ctx, 0, 3, W, 1, shade(top, 0.25)); rect(ctx, 0, 12, W, 4, shade(top, -0.3)); rect(ctx, 1, 12, 2, 4, shade(top, -0.45)); rect(ctx, W - 3, 12, 2, 4, shade(top, -0.45));
      // stuff on desk
      rect(ctx, 11, 8, 10, 3, '#cfd3df'); rect(ctx, 12, 9, 8, 1, '#a9aebf');
      if (h % 3 === 0) { rect(ctx, 25, 5, 3, 3, '#fff'); rect(ctx, 28, 6, 1, 1, '#fff'); rect(ctx, 26, 6, 1, 1, '#7c4a2a'); }
      if (h % 3 === 1) { rect(ctx, 2, 5, 6, 4, '#f4f1e8'); rect(ctx, 3, 6, 4, 1, '#b8b4a6'); }
      if (h % 3 === 2) { rect(ctx, 25, 4, 4, 5, '#3f9d5f'); rect(ctx, 26, 3, 2, 2, '#5ec28a'); }
    },
    chair(ctx) {
      const c = ['#e05d7a', '#4ea3e0', '#5ec28a', '#a67ce0', '#e0884e'][h % 5];
      rect(ctx, 3, 0, 10, 8, shade(c, -0.25)); rect(ctx, 4, 1, 8, 6, c);
      rect(ctx, 3, 8, 10, 6, c); rect(ctx, 3, 12, 10, 2, shade(c, -0.3)); rect(ctx, 7, 14, 2, 2, '#2a2d3a');
    },
    plant(ctx) {
      rect(ctx, 5, 10, 6, 6, '#b5653a'); rect(ctx, 5, 10, 6, 1, '#d98b5a'); rect(ctx, 6, 15, 4, 1, '#8a4a2a');
      const g1 = '#2e8b57', g2 = '#46b072', g3 = '#206b42';
      rect(ctx, 4, -2, 8, 12, g1); rect(ctx, 2, 2, 12, 6, g1); rect(ctx, 5, -4, 6, 4, g2); rect(ctx, 3, 3, 4, 3, g2); rect(ctx, 9, 5, 4, 3, g3); rect(ctx, 7, 0, 2, 8, g3);
    },
    bookshelf(ctx) {
      rect(ctx, 0, -12, W, 28, '#6b4423'); rect(ctx, 1, -11, W - 2, 26, '#3b2514');
      for (let s = 0; s < 3; s++) {
        const sy = -10 + s * 9; rect(ctx, 1, sy + 7, W - 2, 2, '#8a5a2b');
        let x = 2; let k = h + s * 5;
        while (x < W - 4) { const bw = 2 + (k % 2); const bh = 5 + (k % 3); rect(ctx, x, sy + 7 - bh, bw, bh, BOOKS[k % BOOKS.length]); x += bw; k += 3; }
      }
    },
    whiteboard(ctx) {
      rect(ctx, 0, 1, W, 12, '#cfd3df'); rect(ctx, 1, 2, W - 2, 10, '#f6f7fb');
      rect(ctx, 2, 3, 1, 8, '#7c8199'); // marker tray feel
      ctx.fillStyle = '#26327a'; ctx.font = 'bold 3.6px monospace'; ctx.textBaseline = 'top'; ctx.fillText((it.text || '').slice(0, 14), 3.5, 3.2);
      rect(ctx, 3, 7, Math.min(W - 8, 12), 1, '#e05d7a'); rect(ctx, 3, 9, Math.min(W - 10, 8), 1, '#4ea3e0');
      rect(ctx, W - 7, 7, 4, 3, '#e0c24e');
      rect(ctx, 0, 13, W, 1, '#7c8199');
    },
    poster(ctx) {
      const v = it.variant || 0; const cs = [['#e05d7a', '#ffd96a'], ['#4ea3e0', '#fff'], ['#5ec28a', '#1d1d2b']][v % 3];
      rect(ctx, 2, 1, 12, 12, '#f5f1e6'); rect(ctx, 3, 2, 10, 10, cs[0]); rect(ctx, 5, 4, 6, 6, cs[1]); rect(ctx, 7, 6, 2, 2, cs[0]);
    },
    chart(ctx) {
      rect(ctx, 0, 1, W, 12, '#1b2036'); rect(ctx, 1, 2, W - 2, 10, '#0f1427');
      const cs = ['#5ec28a', '#4ea3e0', '#e0c24e', '#e05d7a'];
      for (let i = 0; i < 6; i++) { const hh = 2 + ((h >> i) & 7); rect(ctx, 3 + i * 4, 11 - hh, 3, hh, cs[i % 4]); }
    },
    window(ctx) {
      rect(ctx, 0, 0, W, 13, '#e8efff'); rect(ctx, 1, 1, W - 2, 11, '#8fc7ff'); rect(ctx, 1, 1, W - 2, 4, '#b8dcff');
      rect(ctx, W / 2 - 0.5, 1, 1, 11, '#e8efff'); rect(ctx, 4, 3, 5, 2, '#fff'); rect(ctx, W - 10, 5, 6, 2, '#fff');
    },
    roundtable(ctx) {
      rect(ctx, 2, 2, W - 4, H - 4, '#4a2f1c'); rect(ctx, 0, 4, W, H - 8, '#5a3a22'); rect(ctx, 3, 3, W - 6, H - 8, '#9a6a3c'); rect(ctx, 6, 5, W - 12, H - 12, '#a87848');
      rect(ctx, 3, H - 6, W - 6, 4, '#4a2f1c');
      rect(ctx, W / 2 - 3, H / 2 - 3, 6, 4, '#e8efff'); rect(ctx, W / 2 - 2, H / 2 - 2, 4, 2, '#4ea3e0');
      for (let i = 0; i < 4; i++) { rect(ctx, 10 + i * 20, 6, 4, 3, '#f4f1e8'); rect(ctx, 12 + i * 20, 15, 3, 3, '#fff'); }
    },
    table(ctx) {
      rect(ctx, 0, 3, W, H - 3, '#6a4528'); rect(ctx, 1, 3, W - 2, H - 7, '#b98450'); rect(ctx, 1, 3, W - 2, 1, '#d8a56a');
      rect(ctx, 3, 6, 6, 4, '#cfd3df'); rect(ctx, 4, 7, 4, 2, '#4ea3e0');
      if (it.w >= 3) { rect(ctx, W - 8, 7, 3, 3, '#fff'); rect(ctx, W - 5, 8, 1, 1, '#fff'); }
    },
    coffeetable(ctx) { rect(ctx, 1, 4, W - 2, 9, '#5a3a22'); rect(ctx, 2, 4, W - 4, 6, '#8a5a2b'); rect(ctx, 5, 5, 4, 3, '#fff'); rect(ctx, 6, 6, 2, 1, '#7c4a2a'); },
    couch(ctx) {
      const c = ['#c05a7e', '#4a78c0', '#d9a441', '#5a9e7a'][h % 4];
      const back = it.dirOut === 'up' ? 'bottom' : 'top';
      rect(ctx, 0, back === 'top' ? -2 : 6, W, 12, shade(c, -0.15));
      if (back === 'top') { rect(ctx, 0, -4, W, 8, shade(c, -0.3)); rect(ctx, 1, -3, W - 2, 6, shade(c, -0.1)); rect(ctx, 0, 4, 3, 10, shade(c, -0.3)); rect(ctx, W - 3, 4, 3, 10, shade(c, -0.3)); rect(ctx, 3, 5, W - 6, 8, c); rect(ctx, 3, 5, W - 6, 1, shade(c, 0.2)); }
      else { rect(ctx, 0, 10, W, 6, shade(c, -0.3)); rect(ctx, 0, 0, 3, 12, shade(c, -0.3)); rect(ctx, W - 3, 0, 3, 12, shade(c, -0.3)); rect(ctx, 3, 1, W - 6, 9, c); rect(ctx, 3, 1, W - 6, 1, shade(c, 0.2)); }
      for (let x = 8; x < W - 6; x += 12) rect(ctx, x, back === 'top' ? 5 : 1, 1, 8, shade(c, -0.2));
    },
    easel(ctx) {
      rect(ctx, 3, -8, 10, 14, '#8a5a2b'); rect(ctx, 4, -7, 8, 12, '#fffdf4');
      rect(ctx, 5, -6, 6, 4, '#4ea3e0'); rect(ctx, 5, -3, 3, 4, '#e05d7a'); rect(ctx, 8, -2, 3, 3, '#e0c24e'); rect(ctx, 6, -4, 2, 2, '#fff');
      rect(ctx, 2, 6, 2, 10, '#6a4528'); rect(ctx, 12, 6, 2, 10, '#6a4528'); rect(ctx, 7, 6, 2, 8, '#6a4528'); rect(ctx, 3, 14, 10, 2, '#3a2a1a');
      rect(ctx, 4, 22, 3, 4, '#e05d7a'); rect(ctx, 8, 24, 3, 3, '#4ea3e0');
    },
    serverrack(ctx) {
      rect(ctx, 1, -2, 14, 34, '#161a29'); rect(ctx, 2, -1, 12, 32, '#222842'); rect(ctx, 1, -2, 14, 1, '#3a4266');
      for (let i = 0; i < 7; i++) { rect(ctx, 3, 1 + i * 4, 10, 3, '#12162a'); rect(ctx, 11, 2 + i * 4, 1, 1, '#2a3355'); }
      if (it.glow) { rect(ctx, 0, -3, 1, 36, '#3b8bff55'); rect(ctx, 15, -3, 1, 36, '#3b8bff55'); }
    },
    holotable(ctx) {
      rect(ctx, 2, 6, W - 4, H - 6, '#151a2c'); rect(ctx, 4, 8, W - 8, H - 12, '#1f2742'); rect(ctx, 6, 10, W - 12, H - 16, '#0e1426');
      rect(ctx, 10, 12, W - 20, 1, '#3b8bff'); rect(ctx, 10, H - 8, W - 20, 1, '#3b8bff');
    },
    printer(ctx) { rect(ctx, 1, 4, 14, 10, '#cfd3df'); rect(ctx, 2, 5, 12, 4, '#e8ebf3'); rect(ctx, 3, 0, 10, 5, '#fff'); rect(ctx, 4, 10, 8, 3, '#8a90a6'); rect(ctx, 11, 6, 2, 1, '#5ec28a'); },
    phone(ctx) { rect(ctx, 2, 6, 12, 8, '#3a4160'); rect(ctx, 3, 7, 10, 6, '#262c47'); rect(ctx, 4, 5, 8, 3, '#d8dbe8'); rect(ctx, 5, 9, 2, 2, '#e05d7a'); rect(ctx, 9, 9, 2, 2, '#5ec28a'); },
    pulpit(ctx) {
      rect(ctx, 2, -4, W - 4, 20, '#e9e6f2'); rect(ctx, 3, -3, W - 6, 17, '#f7f5ff'); rect(ctx, 0, -6, W, 4, '#ffd96a'); rect(ctx, 0, 14, W, 2, '#c9a23a');
      rect(ctx, W / 2 - 4, 2, 8, 6, '#ffd96a'); rect(ctx, W / 2 - 2, 3, 4, 4, '#fff6c8');
    },
    reception(ctx) {
      rect(ctx, 0, 2, W, 14, '#2a3050'); rect(ctx, 1, 3, W - 2, 6, '#3a4166'); rect(ctx, 0, 1, W, 3, '#d8d8e2');
      rect(ctx, 4, 10, W - 8, 4, '#12162a'); ctx.fillStyle = '#ffd96a'; ctx.font = 'bold 4px monospace'; ctx.textBaseline = 'top'; ctx.fillText('4EVR', 6, 10.2);
      rect(ctx, W - 14, -2, 8, 5, '#cfd3df'); rect(ctx, W - 13, -1, 6, 3, '#4ea3e0');
    },
    watercooler(ctx) { rect(ctx, 3, 2, 10, 8, '#8fd3ff'); rect(ctx, 4, 1, 8, 2, '#b8e6ff'); rect(ctx, 2, 10, 12, 6, '#e8ebf3'); rect(ctx, 6, 11, 4, 2, '#4a78c0'); rect(ctx, 11, 12, 2, 2, '#e05d7a'); },
    bench(ctx) { rect(ctx, 0, 6, W, 6, '#8a5a2b'); rect(ctx, 1, 6, W - 2, 2, '#b98450'); rect(ctx, 1, 12, 2, 4, '#4a2f1c'); rect(ctx, W - 3, 12, 2, 4, '#4a2f1c'); },
    counter(ctx) {
      rect(ctx, 0, 0, W, 16, '#d8d8e2'); rect(ctx, 0, 0, W, 4, '#9aa1b8'); rect(ctx, 0, 4, W, 12, '#cfd3df'); rect(ctx, 0, 14, W, 2, '#8a90a6');
      for (let x = 2; x < W - 4; x += 16) { rect(ctx, x, 6, 12, 8, '#b8bdd0'); rect(ctx, x + 5, 9, 2, 1, '#6b7186'); }
      rect(ctx, W - 38, 1, 12, 3, '#6b7186'); rect(ctx, W - 33, -2, 2, 3, '#b8bdd0');
    },
    coffee(ctx) { rect(ctx, 2, -6, 12, 14, '#2a2d3a'); rect(ctx, 3, -5, 10, 5, '#d33'); rect(ctx, 5, 2, 6, 5, '#12162a'); rect(ctx, 6, 5, 4, 3, '#fff'); rect(ctx, 11, -3, 2, 2, '#5ec28a'); },
    fridge(ctx) { rect(ctx, 1, -2, 14, 34, '#cfd3df'); rect(ctx, 2, -1, 12, 14, '#e8ebf3'); rect(ctx, 2, 14, 12, 16, '#e8ebf3'); rect(ctx, 11, 2, 1, 6, '#6b7186'); rect(ctx, 11, 18, 1, 6, '#6b7186'); rect(ctx, 2, 13, 12, 1, '#9aa1b8'); },
    vending(ctx) { rect(ctx, 1, -2, 14, 34, '#d33a4a'); rect(ctx, 2, -1, 9, 22, '#12162a'); for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) rect(ctx, 3 + c * 3, 0 + r * 5, 2, 3, BOOKS[(r * 3 + c) % BOOKS.length]); rect(ctx, 12, 2, 2, 6, '#3a4160'); rect(ctx, 3, 24, 10, 4, '#12162a'); },
    pingpong(ctx) {
      rect(ctx, 2, 4, W - 4, H - 6, '#16553a'); rect(ctx, 0, 2, W, H - 6, '#1d7a52'); rect(ctx, 1, 2, W - 2, 1, '#2fa874');
      rect(ctx, W / 2 - 0.5, 2, 1, H - 8, '#fff'); rect(ctx, 2, H / 2 - 1, W - 4, 1, '#ffffff55');
      rect(ctx, W / 2 - 1, 0, 2, H - 4, '#e8ebf3'); rect(ctx, 6, H - 4, 2, 4, '#555'); rect(ctx, W - 8, H - 4, 2, 4, '#555');
    },
    beanbag(ctx) { const c = it.color || '#e05d7a'; rect(ctx, 2, 4, 12, 11, c); rect(ctx, 3, 3, 10, 2, shade(c, 0.2)); rect(ctx, 1, 8, 14, 5, c); rect(ctx, 2, 13, 12, 2, shade(c, -0.3)); },
    dogbed(ctx) { rect(ctx, 2, 4, W - 4, 10, '#4a78c0'); rect(ctx, 4, 6, W - 8, 6, '#7aa3e0'); rect(ctx, 2, 13, W - 4, 1, '#2f4f85'); },
    rug(ctx) {
      const [a, b, c] = RUG[it.color] || RUG.warm;
      rect(ctx, 0, 0, W, H, a); rect(ctx, 2, 2, W - 4, H - 4, b); rect(ctx, 4, 4, W - 8, H - 8, a);
      rect(ctx, 6, 6, W - 12, 1, c); rect(ctx, 6, H - 7, W - 12, 1, c); rect(ctx, 6, 6, 1, H - 12, c); rect(ctx, W - 7, 6, 1, H - 12, c);
    },
    logo_floor(ctx) {
      ctx.fillStyle = '#7a5b1a'; ctx.font = 'bold 14px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('4EVR', W / 2 + 1, H / 2 + 2); ctx.fillStyle = '#ffd96a'; ctx.fillText('4EVR', W / 2, H / 2 + 1);
    },
  };
}

export function renderFurniture(it) {
  const draw = drawers(it)[it.type];
  const w = it.w * T, h = it.h * T + MARGIN;
  const { c, ctx } = makeCanvas(w, h);
  ctx.translate(0, MARGIN);
  if (draw) draw(ctx);
  return { canvas: c, margin: MARGIN };
}

export function sortYOf(it) {
  if (it.type === 'chair') return it.y * T + 8;
  if (it.type === 'couch') return it.y * T + 8;
  return (it.y + it.h) * T;
}
