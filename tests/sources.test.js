// Searching beyond the client's site: news, encyclopaedia, forums and Hacker News.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.ALLOW_PRIVATE_FETCH = '1'; process.env.SEARCH_GAP_MS = '0';
const { webSearch, clearSearchCache, makeToolHandler, TOOL_DEFS } = await import('../server/tools.js');

const bodies = {
  '/news': `<rss><channel><item><title><![CDATA[Acme raises $10M &amp; expands]]></title><link>https://news.example/acme</link><pubDate>Mon, 1 Sep 2026</pubDate><description>&lt;a&gt;Acme&lt;/a&gt; grows</description></item></channel></rss>`,
  '/wiki': JSON.stringify(['acme', ['Acme Corp'], ['A company'], ['https://en.wikipedia.org/wiki/Acme']]),
  '/hn': JSON.stringify({ hits: [{ title: 'Show HN: Acme', url: 'https://acme.test', points: 120, num_comments: 40 }, { story_title: 'Ask HN', objectID: '9', points: 3, num_comments: 1 }] }),
  '/reddit': JSON.stringify({ data: { children: [{ data: { title: 'Is Acme any good?', permalink: '/r/saas/comments/1/x/', subreddit: 'saas', score: 55, selftext: 'We switched last year.' } }] } }),
};
const srv = http.createServer((req, res) => { const p = req.url.split('?')[0]; if (bodies[p]) { res.end(bodies[p]); } else { res.statusCode = 500; res.end('x'); } }).listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
process.env.SEARCH_NEWS_ENDPOINT = `${base}/news?q={q}`; process.env.SEARCH_WIKI_ENDPOINT = `${base}/wiki?q={q}`; process.env.SEARCH_HN_ENDPOINT = `${base}/hn?q={q}`; process.env.SEARCH_REDDIT_ENDPOINT = `${base}/reddit?q={q}`;

test('each outside source is parsed into titles, links and snippets', async () => {
  clearSearchCache();
  const news = await webSearch('acme', { source: 'news' }); assert.equal(news[0].title, 'Acme raises $10M & expands'); assert.equal(news[0].url, 'https://news.example/acme'); assert.match(news[0].snippet, /Acme grows/);
  const wiki = await webSearch('acme', { source: 'wiki' }); assert.equal(wiki[0].url, 'https://en.wikipedia.org/wiki/Acme');
  const hn = await webSearch('acme', { source: 'hn' }); assert.equal(hn.length, 2); assert.match(hn[0].snippet, /120 points/); assert.match(hn[1].url, /ycombinator/);
  const rd = await webSearch('acme', { source: 'reddit' }); assert.equal(rd[0].url, 'https://www.reddit.com/r/saas/comments/1/x/'); assert.match(rd[0].snippet, /r\/saas/);
});

test('the agent tool takes a source, rejects unknown ones back to web, and reports a failing source clearly', async () => {
  clearSearchCache();
  const def = TOOL_DEFS.find((t) => t.name === 'web_search'); assert.deepEqual(def.input_schema.properties.source.enum, ['web', 'news', 'wiki', 'reddit', 'hn']);
  const logs = []; const h = makeToolHandler({ skill: null, log: (t) => logs.push(t) });
  const out = await h('web_search', { query: 'acme', source: 'news' });
  assert.match(out, /untrusted_web_content/); assert.match(out, /Acme raises/); assert.ok(logs.some((l) => /Searched news/.test(l)));
  process.env.SEARCH_NEWS_ENDPOINT = `${base}/missing?q={q}`; clearSearchCache();
  assert.match(await h('web_search', { query: 'acme2', source: 'news' }), /news search failed/);
});
test.after(() => srv.close());
