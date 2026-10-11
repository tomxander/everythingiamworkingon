// The skills library stays current with its upstream GitHub repo, safely, and is what specialists are built from.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { extractSkills, tarEntries, SkillSync } from '../server/skillsync.js';
import { loadSkills } from '../server/skills.js';

process.env.ALLOW_PRIVATE_FETCH = '1';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));

// ---- helpers: a tar writer (ustar + pax long names) and a fake GitHub
function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512); h.write(name.slice(0, 100), 0, 'utf8'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    if (e.name.length > 100) { const rec = `path=${e.name}\n`; let len = rec.length + 3; while (`${len} ${rec}`.length !== len) len = `${len} ${rec}`.length; const px = Buffer.from(`${len} ${rec}`); parts.push(tarHeader('pax', px.length, 'x'), pad(px)); }
    parts.push(tarHeader(e.name, data.length, e.type || '0'), pad(data));
  }
  parts.push(Buffer.alloc(1024)); return zlib.gzipSync(Buffer.concat(parts));
}
const skillMd = (name, desc, body = `# ${name} title\n\nSome real playbook text for ${name}.\n`) => `---\nname: ${name}\ndescription: "${desc}"\nmetadata:\n  version: 1.0.0\n---\n\n${body}`;
const ROOT = 'marketingskills-abc';
const upstream = (extra = []) => makeTar([
  { name: `${ROOT}/`, type: '5' }, { name: `${ROOT}/README.md`, data: 'readme' }, { name: `${ROOT}/skills/`, type: '5' },
  { name: `${ROOT}/skills/seo-audit/SKILL.md`, data: skillMd('seo-audit', 'When the user wants an SEO audit.', '# SEO Audit\n\nNEW upstream guidance on crawling and indexation.\n') },
  { name: `${ROOT}/skills/seo-audit/references/checklist.md`, data: '# Checklist\n- item\n' },
  { name: `${ROOT}/skills/copywriting/SKILL.md`, data: skillMd('copywriting', 'When the user wants copy.') },
  { name: `${ROOT}/skills/marine-logistics/SKILL.md`, data: skillMd('marine-logistics', 'When the user wants marketing for shipping, ports, vessels and marine logistics companies.', '# Marine Logistics Marketing\n\n## Know the buyer\nCharterers and port agents buy on schedule reliability.\n\n## Proof that works\nVoyage on-time performance.\n') },
  { name: `${ROOT}/skills/${'x'.repeat(5)}/scripts/run.sh`, data: 'rm -rf /' },
  ...extra,
]);
let archive = upstream(); let latest = 'a'.repeat(40); let hits = [];
const gh = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url.startsWith('/repos/o/r/commits/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ sha: latest })); }
  if (req.url.startsWith('/o/r/tar.gz/')) { res.writeHead(200, { 'content-type': 'application/gzip' }); return res.end(archive); }
  res.writeHead(404); res.end('no');
});
await new Promise((r) => gh.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${gh.address().port}`;
test.after(() => gh.close());

function setup(mode = 'auto') {
  const dataDir = tmp(); const baseDir = path.join(tmp(), 'skills');
  for (const n of ['seo-audit', 'copywriting', 'ads']) { fs.mkdirSync(path.join(baseDir, n), { recursive: true }); fs.writeFileSync(path.join(baseDir, n, 'SKILL.md'), skillMd(n, `Base ${n}.`, `# ${n}\n\nOLD vendored text.\n`)); }
  const skills = loadSkills(baseDir);
  const sync = new SkillSync({ skills, baseDir, dataDir, repo: 'o/r', mode, apiBase: BASE, archiveBase: BASE, vendoredCommit: 'b'.repeat(40), trustBases: true });
  return { skills, sync, baseDir, dataDir };
}

test('the tar reader handles real archives: GNU tar, pax long names, and the real marketingskills repo', () => {
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'skills', 'a-skill'), { recursive: true }); fs.writeFileSync(path.join(dir, 'skills', 'a-skill', 'SKILL.md'), skillMd('a-skill', 'When x.'));
  const sys = execFileSync('tar', ['czf', '-', '-C', dir, '.'], { maxBuffer: 1e7 });
  const names = [...tarEntries(zlib.gunzipSync(sys))].map((e) => e.name); assert.ok(names.some((n) => n.endsWith('skills/a-skill/SKILL.md')), names.join());
  const longName = `${ROOT}/skills/${'y'.repeat(30)}/references/${'z'.repeat(90)}.md`; assert.ok(longName.length > 100);
  const got = [...tarEntries(zlib.gunzipSync(makeTar([{ name: longName, data: 'long' }])))]; assert.equal(got[0].name, longName, 'pax long names');
  const real = '/home/user/coreyhaines31/marketingskills';
  if (fs.existsSync(path.join(real, '.git'))) {
    const tgz = execFileSync('git', ['-C', real, 'archive', '--format=tar.gz', '--prefix=marketingskills-x/', 'HEAD'], { maxBuffer: 1e8 }); // the same format GitHub serves
    const { skills, rejected } = extractSkills(tgz);
    assert.ok(Object.keys(skills).length >= 45, `real repo yields ${Object.keys(skills).length} skills`); assert.equal(rejected.length, 0, JSON.stringify(rejected.slice(0, 3)));
    const local = loadSkills(); assert.equal(skills.copywriting.hash, local.copywriting.hash, 'identical to the vendored copy');
  }
});

test('extraction keeps only valid markdown skills and rejects everything unsafe', () => {
  const tgz = makeTar([
    { name: `${ROOT}/skills/good/SKILL.md`, data: skillMd('good', 'When good.') }, { name: `${ROOT}/skills/good/references/r.md`, data: 'ref' },
    { name: `${ROOT}/skills/good/references/evil.sh`, data: 'rm -rf /' }, { name: `${ROOT}/skills/good/scripts/x.py`, data: 'print(1)' },
    { name: `${ROOT}/skills/mismatch/SKILL.md`, data: skillMd('different', 'When.') }, { name: `${ROOT}/skills/nodesc/SKILL.md`, data: '---\nname: nodesc\n---\n# x\nbody' },
    { name: `${ROOT}/skills/longdesc/SKILL.md`, data: skillMd('longdesc', 'x'.repeat(1100)) }, { name: `${ROOT}/skills/nofm/SKILL.md`, data: '# no frontmatter' },
    { name: `${ROOT}/skills/Bad_Name/SKILL.md`, data: skillMd('Bad_Name', 'When.') }, { name: `${ROOT}/skills/../../etc/SKILL.md`, data: skillMd('etc', 'When.') },
    { name: `${ROOT}/skills/huge/SKILL.md`, data: skillMd('huge', 'When.', 'x'.repeat(130 * 1024)) }, { name: `${ROOT}/skills/emptybody/SKILL.md`, data: skillMd('emptybody', 'When.', '   ') },
    { name: `${ROOT}/docs/skills/other/SKILL.md`, data: skillMd('other', 'When.') },
  ]);
  const { skills, rejected } = extractSkills(tgz);
  assert.deepEqual(Object.keys(skills), ['good']); assert.deepEqual(Object.keys(skills.good.files).sort(), ['SKILL.md', 'references/r.md']);
  const why = rejected.map((r) => `${r.path}:${r.why}`).join('|');
  for (const w of ['does not match', 'over-long', 'no frontmatter', 'invalid skill name', 'file too large', 'empty body', 'missing or over-long description']) assert.match(why, new RegExp(w), w);
  assert.throws(() => extractSkills(Buffer.from('not a gzip')), /could not be unpacked/);
});

test('auto mode: a newer upstream commit is fetched, validated, layered over the vendored copy, and loaded in place', async () => {
  const { skills, sync, baseDir, dataDir } = setup(); const ref = skills; hits = []; archive = upstream();
  assert.match(skills['seo-audit'].body, /OLD vendored/); assert.ok(!skills['marine-logistics']);
  const events = []; sync.on('updated', (e) => events.push(e));
  const r = await sync.check({ force: true });
  assert.equal(r.result, 'updated'); assert.deepEqual(r.added, ['marine-logistics']); assert.ok(r.changed.includes('seo-audit') && r.changed.includes('copywriting'));
  assert.ok(ref['marine-logistics'] && ref === skills, 'the same object every agent holds was updated in place');
  assert.match(skills['seo-audit'].body, /NEW upstream guidance/); assert.deepEqual(skills['seo-audit'].references, ['references/checklist.md']);
  assert.ok(skills.ads, 'a skill missing upstream is kept, not deleted'); assert.deepEqual(r.removed, ['ads']);
  assert.ok(!fs.existsSync(path.join(dataDir, 'skills-upstream', 'skills', 'xxxxx')), 'scripts and non-markdown files are never written');
  assert.match(fs.readFileSync(path.join(baseDir, 'seo-audit', 'SKILL.md'), 'utf8'), /OLD vendored/, 'the vendored copy is never modified');
  const st = sync.status(); assert.equal(st.commit, 'aaaaaaa'); assert.equal(st.vendoredCommit, 'bbbbbbb'); assert.ok(st.syncedAt && st.canRollback);
  assert.equal(events.length, 1); assert.ok(hits.some((h) => h.startsWith('/repos/o/r/commits/main')) && hits.some((h) => h.startsWith(`/o/r/tar.gz/${latest}`)));
  // survives a restart: the overlay is loaded on top of the vendored copy
  const again = loadSkills(sync.dirs); assert.ok(again['marine-logistics'] && /NEW upstream/.test(again['seo-audit'].body));
  // and the same commit is not downloaded again
  hits = []; const r2 = await sync.check({ force: true }); assert.equal(r2.result, 'up-to-date'); assert.ok(!hits.some((h) => h.includes('tar.gz')));
});

test('checks are throttled, failures are recorded not thrown, and "off" does nothing', async () => {
  const { sync } = setup(); hits = [];
  await sync.check({ force: true }); const n = hits.length; const r = await sync.check(); assert.equal(r.result, 'recent'); assert.equal(hits.length, n, 'no network call within ten minutes');
  const dead = new SkillSync({ skills: {}, baseDir: tmp(), dataDir: tmp(), repo: 'o/r', apiBase: 'http://127.0.0.1:1', archiveBase: 'http://127.0.0.1:1', trustBases: true });
  const bad = await dead.check({ force: true }); assert.equal(bad.result, 'error'); assert.ok(dead.status().lastError);
  const off = setup('off'); hits = []; assert.equal((await off.sync.check()).result, 'off'); assert.equal(hits.length, 0);
  assert.throws(() => new SkillSync({ skills: {}, baseDir: 'x', dataDir: tmp(), repo: 'not a repo' }), /owner\/name/);
});

test('only GitHub is contacted unless the operator chose another base', async () => {
  const s = new SkillSync({ skills: {}, baseDir: tmp(), dataDir: tmp(), repo: 'o/r', apiBase: 'http://169.254.169.254', archiveBase: 'http://evil.example' });
  const saved = { a: process.env.SKILLS_API_BASE, b: process.env.SKILLS_ARCHIVE_BASE }; delete process.env.SKILLS_API_BASE; delete process.env.SKILLS_ARCHIVE_BASE; s.trustBases = false;
  const r = await s.check({ force: true }); assert.equal(r.result, 'error'); assert.match(r.error, /not GitHub/);
  Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v)));
});

test('ask mode: the update waits for approval; declining discards it; approving applies it', async () => {
  const { skills, sync } = setup('ask'); const pend = []; sync.on('pending', (s) => pend.push(s));
  const r = await sync.check({ force: true }); assert.equal(r.result, 'update-available'); assert.ok(pend.length === 1);
  assert.ok(!skills['marine-logistics'], 'nothing is applied yet'); assert.deepEqual(sync.status().pending.added, ['marine-logistics']);
  sync.decline(); assert.equal(sync.status().pending, null); assert.ok(!skills['marine-logistics']);
  await sync.check({ force: true }); const ok = sync.approve(); assert.equal(ok.result, 'updated'); assert.ok(skills['marine-logistics']);
});

test('rollback restores the previous skills, including removing ones the update added', async () => {
  const { skills, sync } = setup(); await sync.check({ force: true }); assert.ok(skills['marine-logistics']);
  const r = sync.rollback(); assert.equal(r.rolledBack, true);
  assert.ok(!skills['marine-logistics'], 'the added skill is gone'); assert.match(skills['seo-audit'].body, /OLD vendored/, 'changed skills are restored');
  assert.equal(sync.status().commit, 'bbbbbbb', 'back on the vendored commit');
  latest = 'c'.repeat(40); await sync.check({ force: true }); latest = 'a'.repeat(40);
  const two = sync.rollback(); assert.ok(two.result === 'rolled-back');
});
