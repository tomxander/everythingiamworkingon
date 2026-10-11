// 4EVR HQ server: serves the office, runs the simulation, talks to the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { buildMap, TILE } from './map.js';
import { AGENTS, COMPANY, DEPT_META } from './roster.js';
import { loadSkills, skillIndex } from './skills.js';
import { Sim } from './sim.js';
import { Life } from './life.js';
import { LLM } from './llm.js';
import { Company } from './company.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(root, 'public');
const DATA = process.env.DATA_DIR || path.join(root, 'data');
const DELIV = process.env.DELIVERABLES_DIR || path.join(root, 'deliverables');

const map = buildMap();
const skills = loadSkills();
const llm = new LLM();
const sim = new Sim(map, AGENTS);
const company = new Company({ sim, llm, skills, dataDir: DATA, deliverablesDir: DELIV });
const life = new Life(sim, company);
const restored = company.load();
life.start();

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };

function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/api/skills') return json(res, 200, skillIndex(skills));
  let m;
  if ((m = p.match(/^\/api\/skill\/([a-z0-9-]+)$/))) {
    const s = skills[m[1]]; if (!s) return json(res, 404, { error: 'no such skill' });
    return json(res, 200, { name: s.name, title: s.title, description: s.description, body: s.body, references: s.references });
  }
  if ((m = p.match(/^\/api\/deliverable\/(D\d+)(\.md)?$/))) {
    const d = company.deliverables.get(m[1]); if (!d) return json(res, 404, { error: 'not found' });
    if (m[2]) { res.writeHead(200, { 'content-type': MIME['.md'], 'content-disposition': `attachment; filename="${d.taskId}-${d.skill}.md"` }); return res.end(d.markdown); }
    return json(res, 200, d);
  }
  if (p === '/api/health') return json(res, 200, { ok: true, mode: llm.mode, restored });
  // static
  let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: ({ origin, req }) => {
    // Only same-origin pages may control the office (the settings panel can hold an API key).
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  },
});

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };

company.on('broadcast', broadcast);

function settings() {
  const s = llm.status();
  return { mode: s.mode, hasKey: s.hasKey, model: s.model, price: s.price, budgetCap: company.budgetCap, lastError: s.lastError };
}

function initPayload() {
  return {
    type: 'init',
    company: { name: COMPANY.name, tagline: COMPANY.tagline },
    map: { TILE, W: map.W, H: map.H, rooms: map.rooms, floor: map.floor, wall: map.wall, furniture: map.furniture, spots: map.spots },
    agents: [...sim.agents.values()].map((a) => ({ id: a.id, short: a.short, name: a.name, role: a.role, dept: a.dept, room: a.room, color: a.color, emoji: a.emoji, skills: a.skills, persona: a.persona, quirks: a.quirks, look: a.look })),
    depts: DEPT_META,
    skills: skillIndex(skills),
    tasks: [...company.tasks.values()].map((t) => company.publicTask(t)),
    deliverables: [...company.deliverables.values()].map((d) => company.deliverableMeta(d)),
    comms: company.comms.slice(-200), log: company.log.slice(-200),
    stats: company.stats(), settings: settings(), snapshot: sim.snapshot(),
  };
}

wss.on('connection', (ws) => {
  send(ws, initPayload());
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      switch (m.type) {
        case 'task': company.submitTask({ title: m.title, brief: m.brief, priority: m.priority, assignee: m.assignee || null }); break;
        case 'retry': company.retryTask(m.taskId); break;
        case 'announce': company.announce(m.text); break;
        case 'coffee': company.coffeeRound(); break;
        case 'townhall': company.townHall(); break;
        case 'bless': company.bless(m.agent); break;
        case 'smite': company.smite(m.agent); break;
        case 'chat': { company.godChat(m.agent, m.text).catch((e) => send(ws, { type: 'toast', text: `Chat failed: ${e.message}`, level: 'warn' })); break; }
        case 'pause': sim.paused = !!m.paused; break;
        case 'speed': sim.speed = Math.min(8, Math.max(0.25, Number(m.speed) || 1)); break;
        case 'setKey': { llm.setKey(m.key); if (m.useLive && llm.apiKey) llm.setMode('live'); broadcast({ type: 'settings', settings: settings() }); break; }
        case 'setMode': llm.setMode(m.mode); broadcast({ type: 'settings', settings: settings() }); break;
        case 'setModel': llm.setModel(String(m.model || '').slice(0, 80)); broadcast({ type: 'settings', settings: settings() }); break;
        case 'setBudget': company.budgetCap = Math.max(0.1, Number(m.value) || 5); broadcast({ type: 'settings', settings: settings() }); break;
        case 'deliverable': { const d = company.deliverables.get(m.id); if (d) send(ws, { type: 'deliverable_full', deliverable: d }); break; }
        case 'skill': { const s = skills[m.name]; if (s) send(ws, { type: 'skill_full', skill: { name: s.name, title: s.title, description: s.description, body: s.body, references: s.references } }); break; }
        default: break;
      }
    } catch (e) {
      send(ws, { type: 'toast', text: e.message || 'Something went wrong', level: 'warn' });
    }
  });
});

// ---------- main loops ----------
let last = Date.now();
setInterval(() => { const now = Date.now(); sim.tick((now - last) / 1000); last = now; }, 50);
setInterval(() => { if (wss.clients.size) broadcast({ type: 'tick', snapshot: sim.snapshot() }); }, 100);
setInterval(() => { company.sampleHistory(); if (wss.clients.size) broadcast({ type: 'stats', stats: company.stats(), settings: settings() }); }, 2000);
setInterval(() => company.save(), 20000);

function shutdown() { company.save(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`\n  4EVR HQ is open  →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  mode: ${llm.mode === 'live' ? `LIVE (${llm.model})` : 'SIMULATED (set ANTHROPIC_API_KEY for real Claude agents)'}  ·  skills loaded: ${Object.keys(skills).length}  ·  agents: ${sim.agents.size}\n`);
});

export { company, sim, llm, server };
