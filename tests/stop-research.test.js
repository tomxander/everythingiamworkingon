// Stopping a task while Sol is still reading the client's site: the reading stops and the task never goes back to planning.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.ALLOW_PRIVATE_FETCH = '1'; process.env.SEARCH_GAP_MS = '0';

let hits = 0;
const srv = http.createServer((req, res) => { hits++; setTimeout(() => { res.setHeader('content-type', 'text/html'); res.end(`<title>Page ${req.url}</title><h1>Acme</h1>${[1, 2, 3, 4, 5, 6].map((i) => `<a href="/p${i}">p${i}</a>`).join('')}`); }, 250); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
for (const k of ['', 'NEWS_', 'WIKI_', 'REDDIT_', 'HN_']) process.env[`SEARCH_${k}ENDPOINT`] = `${B}/s?q={q}`;
const { world, run } = await import('./helpers.js');
test.after(() => srv.close());

test('stopping during site research stops the reading and the task never returns to planning', async () => {
  const w = world({ web: true, outside: true }); const c = w.company; const seen = [];
  c.on('broadcast', (m) => { if (m.type === 'task') seen.push(m.task.status); });
  const t = c.submitTask({ title: `go to ${B}/ and get them more leads`, brief: '' });
  const live = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { w.sim.tick(0.1); await new Promise((r) => setTimeout(r, 10)); } };
  while (t.status !== 'researching') await live(20);
  await live(300); c.cancelTask(t.id); const atStop = hits;
  const end = Date.now() + 15000; while (t.status !== 'cancelled' && Date.now() < end) await live(50);
  assert.equal(t.status, 'cancelled');
  assert.ok(hits - atStop <= 1, `at most the request in flight finishes (${hits - atStop} more)`);
  const after = seen.slice(seen.indexOf('stopping')); assert.ok(!after.includes('planning'), `statuses after stop: ${after.join(',')}`);
});
