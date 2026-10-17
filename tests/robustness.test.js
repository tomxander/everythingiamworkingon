// Edge cases found by an audit: double retries, letting go of someone with queued work, simulated cost vs the real budget, and bracketed IPv6 redirects.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { world, run } from './helpers.js';
import { rawGet, isPrivateAddress } from '../server/tools.js';

const finish = (w, t, max = 3000) => run(w.sim, () => ['done', 'failed', 'cancelled'].includes(t.status), max);
const settle = async (w, p, max = 800) => { let done = false, err = null, val; p.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; }); await run(w.sim, () => done, max); if (err) throw err; return val; };

test('retry only restarts a task that has stopped, so a double click cannot run it twice', async () => {
  const w = world(); const c = w.company;
  const t = c.submitTask({ title: 'Launch a newsletter: 500 subscribers in 90 days', brief: 'B2B.' });
  assert.throws(() => c.retryTask(t.id), /not finished|still running/i, 'a running task cannot be retried');
  c.cancelTask(t.id); await run(w.sim, () => t.status === 'cancelled', 600);
  Object.assign(t, { retro: 'old retro', learned: ['old lesson'], profileId: 'D-old' });
  c.retryTask(t.id);
  assert.deepEqual([t.retro, t.learned, t.profileId], [null, [], null], 'the earlier run leaves nothing behind');
  assert.throws(() => c.retryTask(t.id), /not finished|still running/i, 'the second click is refused');
  assert.ok(await finish(w, t)); assert.equal(t.status, 'done', t.error);
  await run(w.sim, () => c.active === 0, 200);
  assert.equal(c.active, 0, 'no task slot is left occupied');
});

test('someone with a queued task cannot be let go, and a task whose person has left is planned by Vera instead of crashing', async () => {
  const w = world(); const c = w.company;
  const a = await settle(w, c.godHire({ role: 'Video Producer', skills: ['video'], why: 'video series', domain: 'video' }));
  const blockers = [1, 2, 3].map((i) => c.submitTask({ title: `Busy work ${i}: 40 enquiries a month`, brief: 'B2B.' }));
  const queued = c.submitTask({ title: 'A product video script', brief: 'B2B.', assignee: a.id });
  assert.equal(queued.status, 'queued');
  await assert.rejects(c.fire(a.id), /still has work/);
  c.cancelTask(queued.id); for (const b of blockers) c.cancelTask(b.id);
  await run(w.sim, () => c.active === 0, 600);
  await c.fire(a.id);
  c.retryTask(queued.id);
  assert.ok(await finish(w, queued)); assert.equal(queued.status, 'done', queued.error);
  assert.ok((queued.warnings || []).some((x) => /no longer on the team/i.test(x.text || x)), 'the change is explained on the card');
});

test('simulated estimates never count against the real budget cap', async () => {
  const w = world(); const c = w.company; c.budgetCap = 0.01;
  const t = c.submitTask({ title: 'Launch a newsletter: 500 subscribers in 90 days', brief: 'B2B.' });
  assert.ok(await finish(w, t)); assert.ok(w.llm.totals.cost > 0.01, 'the simulator still estimates cost');
  assert.equal(w.llm.totals.spent, 0, 'but nothing was really spent');
  w.llm.mode = 'live'; c.guardBudget();
  assert.equal(w.llm.mode, 'live', 'live mode is not blocked by simulated estimates');
  w.llm.mode = 'mock';
});

test('IPv6 literals are checked with or without brackets, including hex-mapped IPv4', async () => {
  for (const ip of ['::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', 'fd00::1', 'fe80::1']) assert.ok(isPrivateAddress(ip), ip);
  assert.ok(!isPrivateAddress('2606:4700::1111'), 'public IPv6 stays allowed');
  const srv = http.createServer((_, res) => { res.writeHead(302, { location: 'http://[::ffff:7f00:1]:9/' }); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prev = process.env.ALLOW_PRIVATE_FETCH;
  try {
    // the first hop is local only because the test server is; the redirect target must still be refused
    process.env.ALLOW_PRIVATE_FETCH = '';
    await assert.rejects(rawGet('http://[::ffff:7f00:1]:9/'), /private or internal/);
    await assert.rejects(rawGet('http://[::1]:9/'), /private or internal/);
  } finally { if (prev === undefined) delete process.env.ALLOW_PRIVATE_FETCH; else process.env.ALLOW_PRIVATE_FETCH = prev; srv.close(); }
});
