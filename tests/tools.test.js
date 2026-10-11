import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPrivateAddress, normalizeUrl, extractUrls, fetchPage, crawlSite, siteFindings, extractPage } from '../server/tools.js';

const HOME = `<!doctype html><html lang="en"><head><title>Acme Cables | Industrial cable assemblies for OEMs</title>
<meta name="description" content="Custom cable assemblies, built to spec."><script>var x=1;</script></head><body>
<header><nav><a href="/products">Products</a><a href="/about">About</a><a href="/contact">Contact</a><a href="/pricing">Pricing</a></nav></header>
<main><h1>Cable assemblies that do not fail</h1><h2>Trusted by 200 OEMs</h2><p>We design and build custom cable assemblies for rail, medical and industrial customers.</p>
<a href="/contact">Request a quote</a> <a href="mailto:sales@acme.test">Email us</a> <button>Download catalogue</button><img src="a.png"><img src="b.png" alt="b"></main></body></html>`;
const CONTACT = `<html><head><title>Contact</title></head><body><h1>Contact</h1><form action="/send"><input name="name"><input name="email" type="email"><input name="phone"><input name="company"><input name="role"><input name="msg"><input type="hidden" name="t"><input type="submit"></form></body></html>`;
const PAGES = { '/': HOME, '/contact': CONTACT, '/products': '<title>Products</title><h1>Products</h1><p>Harnesses and looms.</p>', '/about': '<title>About</title><h1>About us</h1>' };

const server = http.createServer((req, res) => {
  if (req.url === '/redir') { res.writeHead(302, { location: '/contact' }); return res.end(); }
  if (req.url === '/slow') return; // never answers
  const body = PAGES[req.url.split('?')[0]];
  if (!body) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('private and internal addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('fetch refuses private targets (SSRF) unless explicitly allowed', async () => {
  delete process.env.ALLOW_PRIVATE_FETCH;
  await assert.rejects(fetchPage(`${base}/`), /private or internal/);
  await assert.rejects(fetchPage('http://169.254.169.254/latest/meta-data/'), /private or internal/);
  await assert.rejects(fetchPage('http://localhost:1/'), /private or internal|ECONNREFUSED/);
  await assert.rejects(fetchPage('file:///etc/passwd'), /valid web address/);
  await assert.rejects(fetchPage('ftp://example.com/x'), /valid web address/);
});

test('url normalisation and extraction from free text', () => {
  assert.equal(normalizeUrl('Acsiatech.com'), 'https://acsiatech.com/');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('notadomain'), null);
  assert.deepEqual(extractUrls('go to Acsiatech.com and make them get more leads'), ['https://acsiatech.com/']);
  assert.deepEqual(extractUrls('see https://www.example.org/pricing, and also foo.io.'), ['https://www.example.org/pricing', 'https://foo.io/']);
  assert.deepEqual(extractUrls('email me at tom@acme.com about e.g. the plan'), []);
  assert.deepEqual(extractUrls('no links here, just 10.5 percent growth'), []);
});

test('page extraction finds the evidence a marketer needs', async () => {
  process.env.ALLOW_PRIVATE_FETCH = '1';
  const p = await fetchPage(`${base}/`);
  assert.match(p.title, /Acme Cables/);
  assert.equal(p.description, 'Custom cable assemblies, built to spec.');
  assert.equal(p.headings.find((h) => h.level === 1).text, 'Cable assemblies that do not fail');
  assert.ok(p.ctas.some((c) => /request a quote/i.test(c.text)));
  assert.ok(p.ctas.some((c) => /download catalogue/i.test(c.text)));
  assert.ok(p.links.some((l) => l.kind === 'mailto'));
  assert.equal(p.imgNoAlt, 1);
  assert.ok(!/var x=1/.test(p.text), 'scripts are stripped');
  const redirected = await fetchPage(`${base}/redir`);
  assert.match(redirected.url, /\/contact$/);
  assert.equal(redirected.forms[0].fields, 6);
});

test('crawl reads the key pages and reports findings from the page itself', async () => {
  process.env.ALLOW_PRIVATE_FETCH = '1';
  const snap = await crawlSite(base, { maxPages: 5 });
  const urls = snap.pages.map((p) => new URL(p.url).pathname);
  assert.ok(urls.includes('/') && urls.includes('/contact') && urls.includes('/products'), urls.join());
  assert.equal(snap.errors.filter((e) => /pricing/.test(e.url)).length, 1, '404 pages are reported, not hidden');
  const f = siteFindings(snap).join(' | ');
  assert.match(f, /more than 5 fields/);
  assert.match(f, /No analytics or tracking/);
  assert.match(f, /structured data/);
  assert.doesNotMatch(f, /no lead capture form/i, 'a form exists, so this must not be claimed');
});

test('failures are explicit, not silent', async () => {
  process.env.ALLOW_PRIVATE_FETCH = '1';
  await assert.rejects(fetchPage(`${base}/missing`), /HTTP 404/);
  const snap = await crawlSite(`${base}/missing`);
  assert.equal(snap.pages.length, 0); assert.match(snap.errors[0].error, /404/);
  const p = extractPage('<html><body>hi</body></html>', 'https://x.test/');
  assert.deepEqual(p.forms, []);
});
