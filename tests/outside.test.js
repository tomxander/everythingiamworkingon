// Research beyond the client's own site, and asking God when the outside world has nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.ALLOW_PRIVATE_FETCH = '1'; process.env.SEARCH_GAP_MS = '0';

const PAGES = { '/': '<title>Acme Cables</title><meta name="description" content="Cable assemblies."><h1>Cables that do not fail</h1><a href="/contact">Contact</a>', '/contact': '<title>Contact</title><h1>Contact</h1>' };
let empty = false; const queries = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (PAGES[p]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGES[p]); }
  queries.push(`${p}:${u.searchParams.get('q') || u.searchParams.get('search') || u.searchParams.get('query')}`);
  if (p === '/news') return res.end(empty ? '<rss><channel></channel></rss>' : '<rss><channel><item><title>Acme wins contract</title><link>https://news.example/acme</link><description>Big win</description></item></channel></rss>');
  if (p === '/wiki') return res.end(JSON.stringify(empty ? ['x', [], [], []] : ['x', ['Acme Cables'], ['Maker'], ['https://en.wikipedia.org/wiki/Acme']]));
  if (p === '/reddit') return res.end(JSON.stringify({ data: { children: empty ? [] : [{ data: { title: 'Acme Cables review', permalink: '/r/x/1', subreddit: 'x', score: 3, selftext: '' } }] } }));
  if (p === '/web') return res.end(empty ? '<html>nothing</html>' : '<div class="result"><a class="result__a" href="https://rival.example/">Rival Cables</a><a class="result__snippet">The alternative</a></div>');
  res.statusCode = 404; res.end();
}).listen(0);
await new Promise((r) => srv.once('listening', r));
const B = `http://127.0.0.1:${srv.address().port}`;
process.env.SEARCH_NEWS_ENDPOINT = `${B}/news?q={q}`; process.env.SEARCH_WIKI_ENDPOINT = `${B}/wiki?search={q}`; process.env.SEARCH_REDDIT_ENDPOINT = `${B}/reddit?q={q}`; process.env.SEARCH_ENDPOINT = `${B}/web?q={q}`;
const { world, run } = await import('./helpers.js');
const { clearSearchCache } = await import('../server/tools.js');
test.after(() => srv.close());

test('the profile uses evidence from the wider internet, not just the client site', async () => {
  clearSearchCache(); empty = false; queries.length = 0;
  const w = world({ web: true, outside: true });
  const t = w.company.submitTask({ title: `go to ${B}/ and get them more leads`, brief: '' });
  assert.ok(await run(w.sim, () => ['done', 'failed'].includes(t.status), 6000)); assert.equal(t.status, 'done', t.error);
  const host = t.sources[0].host; const ext = w.company.clients.get(host).external;
  assert.ok(ext.found >= 3, `found ${ext.found}`); assert.deepEqual([...new Set(ext.queries.map((q) => q.source))].sort(), ['news', 'reddit', 'web', 'wiki']);
  assert.ok(queries.some((q) => q.startsWith('/news')) && queries.some((q) => q.startsWith('/reddit')) && queries.some((q) => q.startsWith('/web')));
  const profile = w.company.deliverables.get(t.profileId).markdown;
  assert.match(profile, /Outside the site/); assert.match(profile, /\[news\] Acme wins contract/); assert.match(profile, /rival\.example/);
  assert.ok(!w.company.requestsPublic().some((r) => r.origin === 'research'), 'nothing missing, so nothing asked');
  assert.ok(w.company.comms.some((m) => m.kind === 'research' && /Searched news/.test(m.text)));
});

test('when searches work but find nothing, the gap goes to God instead of being guessed', async () => {
  clearSearchCache(); empty = true;
  const w = world({ web: true, outside: true });
  const t = w.company.submitTask({ title: `go to ${B}/ and get them more leads`, brief: '' });
  assert.ok(await run(w.sim, () => ['done', 'failed'].includes(t.status), 6000)); assert.equal(t.status, 'done', t.error);
  const r = w.company.requestsPublic().find((x) => x.origin === 'research'); assert.ok(r, 'a research request exists');
  assert.equal(r.by, 'sol'); assert.match(r.what, /competitors/); assert.match(r.tried, /no results/);
  assert.match(w.company.deliverables.get(t.profileId).markdown, /found nothing about this company outside its own site/);
});

test('when the outside search is down, it is said plainly and nobody is bothered', async () => {
  clearSearchCache(); empty = false;
  const saved = { ...process.env }; process.env.SEARCH_NEWS_ENDPOINT = `${B}/gone`; process.env.SEARCH_WIKI_ENDPOINT = `${B}/gone`; process.env.SEARCH_REDDIT_ENDPOINT = `${B}/gone`; process.env.SEARCH_ENDPOINT = `${B}/gone`;
  const w = world({ web: true, outside: true });
  const t = w.company.submitTask({ title: `go to ${B}/ and get them more leads`, brief: '' });
  assert.ok(await run(w.sim, () => ['done', 'failed'].includes(t.status), 6000)); assert.equal(t.status, 'done', t.error);
  assert.ok(!w.company.requestsPublic().some((r) => r.origin === 'research'));
  assert.match(w.company.deliverables.get(t.profileId).markdown, /Outside search was unavailable/);
  Object.assign(process.env, saved);
});
