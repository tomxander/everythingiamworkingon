// Stopping and deleting tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let inflight = 0; const api = http.createServer((req, res) => { inflight++; req.resume(); setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'late' }], usage: { input_tokens: 1, output_tokens: 1 } })); }, 15000); }).listen(0);
await new Promise((r) => api.once('listening', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${api.address().port}`;
process.env.CLAUDE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const { world, run } = await import('./helpers.js');
const { ClaudeCli } = await import('../server/claude-cli.js');
test.after(() => { api.closeAllConnections?.(); api.close(); });

const submit = (w, title = 'Get acme.test more leads: 40 enquiries a month') => w.company.submitTask({ title, brief: 'B2B SaaS. Budget $5k.' });

test('stopping a running task: work stops, nothing new starts, agents are freed, its open requests are withdrawn, Retry runs it again', async () => {
  const w = world(); const t = submit(w);
  assert.ok(await run(w.sim, () => t.subtasks.some((s) => s.status === 'done') && t.subtasks.some((s) => s.status !== 'done'), 3000), 'mid-task');
  const doneBefore = t.subtasks.filter((s) => s.status === 'done').length;
  w.company.cancelTask(t.id); assert.equal(t.status, 'stopping');
  assert.ok(await run(w.sim, () => t.status === 'cancelled', 600), `stopped (${t.status})`);
  assert.equal(t.summaryId, null, 'no summary for a stopped task');
  assert.ok(t.subtasks.every((s) => ['done', 'failed', 'cancelled'].includes(s.status)));
  assert.equal(t.subtasks.filter((s) => s.status === 'done').length, doneBefore, 'nothing finished after the stop');
  assert.ok(t.subtasks.some((s) => s.status === 'cancelled'));
  await run(w.sim, () => false, 60); assert.ok([...w.sim.agents.values()].every((a) => !a.busy), 'everyone is free');
  assert.ok(!w.company.requestsPublic().some((r) => r.taskId === t.id && r.status === 'open'), 'no open requests left');
  assert.throws(() => w.company.cancelTask(t.id), /not running/);
  w.company.retryTask(t.id); assert.equal(t.cancelled, false);
  assert.ok(await run(w.sim, () => t.status === 'done', 3000)); assert.ok(t.summaryId);
});

test('a queued task stops at once and never runs', async () => {
  const w = world(); const ts = [1, 2, 3, 4].map((i) => submit(w, `Task number ${i} for acme.test leads`));
  const q = ts[3]; assert.equal(q.status, 'queued');
  w.company.cancelTask(q.id); assert.equal(q.status, 'cancelled');
  await run(w.sim, () => ts.slice(0, 3).every((t) => t.status === 'done'), 4000);
  assert.equal(q.status, 'cancelled'); assert.equal(q.subtasks.length, 0);
});

test('stopping aborts a model call in flight instead of waiting for it', async () => {
  const w = world(); w.llm.apiKey = 'k'; w.llm.setMode('live'); inflight = 0;
  const t = submit(w, 'Learn about Acsia Technologies');
  const end = Date.now() + 5000; while (!inflight && Date.now() < end) { w.sim.tick(0.1); await new Promise((r) => setTimeout(r, 10)); }
  assert.ok(inflight, 'a call is in flight'); const t0 = Date.now();
  w.company.cancelTask(t.id);
  while (t.status !== 'cancelled' && Date.now() - t0 < 5000) { w.sim.tick(0.1); await new Promise((r) => setTimeout(r, 10)); }
  assert.equal(t.status, 'cancelled'); assert.ok(Date.now() - t0 < 3000, `stopped in ${Date.now() - t0}ms, not after the 15s call`);
  assert.equal(w.llm.lastError, null, 'a stop is not an API error'); assert.ok(!(t.warnings || []).length, 'and not a fallback warning');
});

test('stopping kills a Claude CLI call', async () => {
  process.env.FAKE_HANG = '1'; const cli = new ClaudeCli(); const ctrl = new AbortController(); const t0 = Date.now();
  const p = cli.run({ system: 's', user: 'u', signal: ctrl.signal, timeoutMs: 20000 }); setTimeout(() => ctrl.abort(), 300);
  await assert.rejects(p, (e) => e.cancelled === true); assert.ok(Date.now() - t0 < 3000); delete process.env.FAKE_HANG;
});

test('deleting: a finished task goes with its deliverables, files, requests and messages; a running one is stopped first', async () => {
  const w = world(); const events = []; w.company.on('broadcast', (m) => events.push(m));
  const t = submit(w); assert.ok(await run(w.sim, () => t.status === 'done', 3000));
  const dir = path.join(w.company.deliverablesDir, t.id); assert.ok(fs.existsSync(dir));
  assert.ok(w.company.requestsPublic().some((r) => r.taskId === t.id));
  assert.deepEqual(w.company.deleteTask(t.id), { pending: false });
  assert.equal(w.company.tasks.has(t.id), false); assert.ok(![...w.company.deliverables.values()].some((d) => d.taskId === t.id)); assert.ok(!fs.existsSync(dir));
  assert.ok(!w.company.requestsPublic().some((r) => r.taskId === t.id)); assert.ok(!w.company.comms.some((c) => c.taskId === t.id));
  assert.ok(events.some((e) => e.type === 'task_deleted' && e.id === t.id));
  const t2 = submit(w); assert.ok(await run(w.sim, () => t2.status === 'active', 2000));
  assert.deepEqual(w.company.deleteTask(t2.id), { pending: true }); assert.equal(t2.status, 'stopping');
  assert.ok(await run(w.sim, () => !w.company.tasks.has(t2.id), 600), 'removed once it wound down');
  const w2 = world(); w2.company.dataDir = w.company.dataDir; w2.company.load(); assert.ok(!w2.company.tasks.has(t.id) && !w2.company.tasks.has(t2.id), 'deletion persists');
});
