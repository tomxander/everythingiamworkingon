// Tools agents can use. The important one is reading the web: without it an
// instruction like "go to example.com and get them more leads" is just text.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (compatible; 4EVR-HQ/1.0; +https://github.com/tomxander/everythingiamworkingon)';

// ---------------------------------------------------------------- SSRF guard
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true;
}

// Validates at connect time, so a hostname cannot resolve to a public address
// when checked and a private one when used.
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const allow = process.env.ALLOW_PRIVATE_FETCH === '1';
    const ok = addrs.filter((a) => allow || !isPrivateAddress(a.address));
    if (!ok.length) return cb(new Error('Blocked: that address is private or internal.'));
    if (options && options.all) return cb(null, ok);
    return cb(null, ok[0].address, ok[0].family);
  });
}

export function normalizeUrl(input) {
  let s = String(input || '').trim().replace(/[)\].,;:'"]+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!u.hostname.includes('.') && !net.isIP(u.hostname) && u.hostname !== 'localhost') return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

function rawGet(urlStr, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('Invalid URL')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Only http and https are supported'));
    if (net.isIP(u.hostname) && process.env.ALLOW_PRIVATE_FETCH !== '1' && isPrivateAddress(u.hostname)) return reject(new Error('Blocked: that address is private or internal.'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET', lookup: guardedLookup, timeout: TIMEOUT_MS,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        let next; try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new Error('Bad redirect')); }
        return resolve(rawGet(next, redirectsLeft - 1));
      }
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip()); else if (enc === 'deflate') stream = res.pipe(zlib.createInflate()); else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0; let done = false;
      const finish = (err) => { if (done) return; done = true; if (err) reject(err); else resolve({ status, finalUrl: u.toString(), type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }); };
      stream.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { chunks.push(c.subarray(0, Math.max(0, c.length - (size - MAX_BYTES)))); req.destroy(); finish(); } else chunks.push(c); });
      stream.on('end', () => finish()); stream.on('error', (e) => finish(e)); res.on('error', (e) => finish(e));
      req.on('close', () => finish());
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------- HTML -> evidence
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = (s) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const CTA_RE = /\b(get|start|try|book|schedule|request|contact|talk|download|sign ?up|subscribe|buy|demo|quote|free|join|learn more|enquire|inquire|call)\b/i;

export function extractPage(html, pageUrl) {
  const base = new URL(pageUrl);
  const clean = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
  const title = strip((clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const meta = (name) => { const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i')); const c = m && m[0].match(/content=["']([^"']*)["']/i); return c ? decode(c[1]).trim() : ''; };
  const headings = [...clean.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), text: strip(m[2]) })).filter((h) => h.text && h.text.length < 160).slice(0, 40);
  const links = []; const ctas = []; const seen = new Set();
  for (const m of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/href=["']([^"']+)["']/i) || [])[1]; const text = strip(m[2]);
    if (!href || /^(javascript:|#)/i.test(href)) continue;
    let abs; try { abs = new URL(href, base); } catch { continue; }
    if (abs.protocol === 'mailto:' || abs.protocol === 'tel:') { links.push({ url: abs.toString(), text: text || abs.pathname, kind: abs.protocol.replace(':', '') }); continue; }
    if (!/^https?:$/.test(abs.protocol)) continue; abs.hash = '';
    const key = abs.toString(); if (seen.has(key + text)) continue; seen.add(key + text);
    const internal = abs.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '');
    links.push({ url: key, text, internal });
    if (text && text.length < 50 && CTA_RE.test(text)) ctas.push({ text, url: key });
  }
  for (const m of clean.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) { const t = strip(m[1]); if (t && t.length < 50 && CTA_RE.test(t)) ctas.push({ text: t, url: null }); }
  const forms = [...clean.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)].map((m) => {
    const fields = [...m[1].matchAll(/<(input|select|textarea)\b([^>]*)>/gi)].map((f) => ({ type: (f[2].match(/type=["']([^"']+)/i) || [, f[1]])[1].toLowerCase(), name: (f[2].match(/(?:name|placeholder|aria-label)=["']([^"']+)/i) || [])[1] || '' })).filter((f) => !['hidden', 'submit', 'button'].includes(f.type));
    return { fields: fields.length, names: fields.map((f) => f.name).filter(Boolean).slice(0, 8) };
  });
  const body = (clean.match(/<main[\s\S]*?<\/main>/i) || clean.match(/<body[\s\S]*<\/body>/i) || [clean])[0];
  const text = strip(body.replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, ' ')).slice(0, 6000);
  return {
    url: pageUrl, title, description: meta('description') || meta('og:description'), ogTitle: meta('og:title'), canonical: (html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i) || [])[1] || '',
    robots: meta('robots'), lang: (html.match(/<html[^>]+lang=["']([^"']+)/i) || [])[1] || '', headings, ctas: dedupeBy(ctas, (c) => c.text.toLowerCase()).slice(0, 12), forms, links: links.slice(0, 150),
    hasJsonLd: /application\/ld\+json/i.test(html), hasViewport: /name=["']viewport["']/i.test(html), imgCount: (clean.match(/<img\b/gi) || []).length, imgNoAlt: (clean.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) || []).length,
    analytics: detectAnalytics(html), text, words: text.split(/\s+/).filter(Boolean).length,
  };
}
const dedupeBy = (arr, f) => { const s = new Set(); return arr.filter((x) => (s.has(f(x)) ? false : s.add(f(x)))); };
function detectAnalytics(html) {
  const found = [];
  if (/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/i.test(html)) found.push('Google Tag Manager');
  if (/gtag\(|googletagmanager\.com\/gtag|google-analytics\.com|G-[A-Z0-9]{6,}/i.test(html)) found.push('Google Analytics');
  if (/connect\.facebook\.net|fbq\(/i.test(html)) found.push('Meta Pixel');
  if (/snap\.licdn\.com|linkedin\.com\/px|_linkedin_partner_id/i.test(html)) found.push('LinkedIn Insight Tag');
  if (/hotjar|clarity\.ms/i.test(html)) found.push('Hotjar/Clarity');
  if (/hs-scripts\.com|hubspot/i.test(html)) found.push('HubSpot');
  if (/zohopagesense|zoho/i.test(html)) found.push('Zoho');
  if (/salesforce|pardot/i.test(html)) found.push('Salesforce/Pardot');
  return found;
}

export async function fetchPage(urlInput) {
  const url = normalizeUrl(urlInput); if (!url) throw new Error('That does not look like a valid web address.');
  const res = await rawGet(url);
  if (res.status >= 400) throw new Error(`The site returned HTTP ${res.status}`);
  if (!/html|xml|text\/plain/i.test(res.type) && res.body.slice(0, 200).indexOf('<') === -1) throw new Error(`Unsupported content type: ${res.type || 'unknown'}`);
  const page = extractPage(res.body, res.finalUrl);
  page.status = res.status;
  return page;
}

const PRIORITY = [/pricing|plans/i, /product|platform|solution|service|offering/i, /about|company|who-we/i, /contact|demo|quote|book|get-in-touch/i, /case-stud|customer|success|portfolio|work/i, /industr|sector|use-case/i, /blog|resources|insights|news/i];
export async function crawlSite(urlInput, { maxPages = 6 } = {}) {
  const start = normalizeUrl(urlInput); if (!start) throw new Error('Invalid web address.');
  const pages = []; const errors = [];
  let home;
  try { home = await fetchPage(start); pages.push(home); } catch (e) { return { start, host: new URL(start).hostname, pages, errors: [{ url: start, error: e.message }] }; }
  const origin = new URL(home.url);
  const internal = home.links.filter((l) => l.internal && !l.kind).map((l) => l.url).filter((u) => { try { const x = new URL(u); return x.pathname !== '/' && !/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|css|js)$/i.test(x.pathname) && x.pathname !== origin.pathname; } catch { return false; } });
  const ranked = []; const used = new Set();
  for (const re of PRIORITY) { const hit = internal.find((u) => re.test(new URL(u).pathname) && !used.has(u)); if (hit) { ranked.push(hit); used.add(hit); } }
  for (const u of internal) { if (ranked.length >= maxPages - 1) break; if (!used.has(u)) { ranked.push(u); used.add(u); } }
  const targets = ranked.slice(0, maxPages - 1);
  const results = await Promise.allSettled(targets.map((u) => fetchPage(u)));
  results.forEach((r, i) => (r.status === 'fulfilled' ? pages.push(r.value) : errors.push({ url: targets[i], error: r.reason?.message || 'failed' })));
  return { start, host: origin.hostname.replace(/^www\./, ''), pages, errors, fetchedAt: Date.now() };
}

/** Findings that come straight from the page, independent of any model. */
export function siteFindings(snapshot) {
  const out = []; const pages = snapshot.pages || []; if (!pages.length) return out;
  const home = pages[0];
  if (!home.title) out.push('The homepage has no title tag.'); else if (home.title.length > 65) out.push(`The homepage title is ${home.title.length} characters and will be truncated in search results.`);
  if (!home.description) out.push('The homepage has no meta description.');
  const h1s = home.headings.filter((h) => h.level === 1); if (!h1s.length) out.push('The homepage has no H1.'); else if (h1s.length > 1) out.push(`The homepage has ${h1s.length} H1 tags.`);
  const forms = pages.reduce((n, p) => n + p.forms.length, 0);
  if (!forms) out.push(`No lead capture form was found on any of the ${pages.length} pages read.`);
  else { const big = pages.flatMap((p) => p.forms).filter((f) => f.fields > 5); if (big.length) out.push(`${big.length} form(s) ask for more than 5 fields, which usually lowers completion.`); }
  const homeCtas = home.ctas.length; if (!homeCtas) out.push('No clear call-to-action was found on the homepage.'); else if (homeCtas > 6) out.push(`The homepage has ${homeCtas} competing calls to action.`);
  const contact = pages.flatMap((p) => p.links.filter((l) => l.kind)); if (!contact.some((l) => l.kind === 'tel') && !contact.some((l) => l.kind === 'mailto')) out.push('No visible phone number or email link was found.');
  if (!pages.some((p) => p.analytics.length)) out.push('No analytics or tracking tags were detected, so lead sources may not be measurable.');
  if (!home.hasJsonLd) out.push('No structured data (JSON-LD) was found on the homepage.');
  if (!home.hasViewport) out.push('No mobile viewport tag was found.');
  if (home.imgNoAlt > 0) out.push(`${home.imgNoAlt} of ${home.imgCount} homepage images have no alt text.`);
  if (home.words < 150) out.push(`The homepage has only about ${home.words} words of readable text (it may be built with client-side rendering, which would also limit what was readable here).`);
  const thin = pages.filter((p) => p.words < 80).length; if (thin > 1) out.push(`${thin} pages read have very little text.`);
  return out;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export function pageToText(p, max = 3500) {
  const lines = [`URL: ${p.url}`, `Title: ${p.title || '(none)'}`, `Meta description: ${p.description || '(none)'}`];
  if (p.headings.length) lines.push('Headings:\n' + p.headings.slice(0, 18).map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n'));
  if (p.ctas.length) lines.push('Calls to action: ' + p.ctas.slice(0, 8).map((c) => `"${c.text}"`).join(', '));
  lines.push(`Forms: ${p.forms.length ? p.forms.map((f) => `${f.fields} fields${f.names.length ? ' (' + f.names.join(', ') + ')' : ''}`).join('; ') : 'none'}`);
  if (p.analytics.length) lines.push('Tracking detected: ' + p.analytics.join(', '));
  lines.push('Text:\n' + clip(p.text, max));
  return lines.join('\n');
}
export function snapshotToText(s, { perPage = 2200, total = 14000 } = {}) {
  if (!s?.pages?.length) return `Could not read ${s?.start || 'the site'}: ${(s?.errors || []).map((e) => e.error).join('; ') || 'unknown error'}.`;
  const body = s.pages.map((p, i) => `--- Page ${i + 1} ---\n${pageToText(p, perPage)}`).join('\n\n');
  const findings = siteFindings(s);
  const t = `${body}\n\n--- Automatic observations ---\n${findings.map((f) => `- ${f}`).join('\n') || '- none'}`;
  return clip(t, total);
}

// ---------------------------------------------------------------- finding URLs in a brief
const TLD = 'com|net|org|io|co|ai|app|dev|tech|in|uk|de|fr|es|nl|se|no|dk|fi|ch|at|be|it|pl|eu|us|ca|au|nz|sg|ae|sa|za|jp|kr|cn|hk|tw|br|mx|ar|cl|info|biz|me|tv|xyz|online|site|store|shop|agency|digital|cloud|software|systems|solutions';
export function extractUrls(text) {
  const t = String(text || ''); const out = [];
  for (const m of t.matchAll(/https?:\/\/[^\s<>"')]+/gi)) out.push(m[0]);
  for (const m of t.matchAll(new RegExp(`(?<![@\\w./-])((?:[a-z0-9-]+\\.)+(?:${TLD}))(?![\\w-])(\\/[^\\s<>"')]*)?`, 'gi'))) out.push(m[0]);
  const urls = []; const seen = new Set();
  for (const raw of out) { const u = normalizeUrl(raw); if (!u) continue; const h = new URL(u).hostname.replace(/^www\./, '').toLowerCase(); if (seen.has(h)) continue; seen.add(h); urls.push(u); }
  return urls.slice(0, 3);
}

// ---------------------------------------------------------------- tool definitions for live agents
export const TOOL_DEFS = [
  { name: 'fetch_url', description: 'Fetch and read a public web page. Returns the title, meta description, headings, calls to action, forms, detected tracking and the main text. Use it to verify facts about the client, their pages or competitors instead of guessing. Only public http(s) pages work.', input_schema: { type: 'object', properties: { url: { type: 'string', description: 'The full URL or domain to read.' } }, required: ['url'] } },
  { name: 'read_skill_reference', description: 'Read one of the reference files that belongs to your active skill (they are listed at the end of the skill text). Use when the skill tells you to consult a reference.', input_schema: { type: 'object', properties: { file: { type: 'string', description: 'The reference file name, for example "benchmarks.md".' } }, required: ['file'] } },
];

export function makeToolHandler({ skill, log }) {
  let fetches = 0;
  return async (name, input) => {
    if (name === 'fetch_url') {
      if (++fetches > 6) return 'Fetch limit reached for this piece of work. Use what you have and state what you could not verify.';
      try { const p = await fetchPage(input.url); log?.(`Read ${p.url}`); return pageToText(p, 6000); } catch (e) { log?.(`Could not read ${input.url}: ${e.message}`); return `Could not read that page: ${e.message}. Say clearly in your deliverable that this could not be verified.`; }
    }
    if (name === 'read_skill_reference') {
      const file = path.basename(String(input.file || ''));
      if (!skill || !skill.references.includes(file)) return `No such reference. Available: ${(skill?.references || []).join(', ') || 'none'}.`;
      try { return clip(fs.readFileSync(path.join(skill.dir, 'references', file), 'utf8'), 14000); } catch { return 'Could not read that reference.'; }
    }
    return `Unknown tool: ${name}`;
  };
}
