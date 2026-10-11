// Keeps the team's skill library current with its upstream GitHub repository
// (default: coreyhaines31/marketingskills). Specialists are always built from this library, so a
// hire made after an update is built from the newest playbooks.
//
// Safety: only GitHub hosts are contacted (unless a test overrides the base URLs); the archive is
// size-capped and parsed by a hardened reader that only accepts skills/<name>/SKILL.md and
// references/*.md; every skill is validated; updates go to an overlay in data/ (the tracked vendor
// copy is never modified); the previous overlay is kept so an update can be rolled back; and
// SKILLS_UPDATE=ask makes you approve each update, because skill text becomes part of agent prompts.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { rawGet } from './tools.js';
import { loadSkills, reloadSkills, REF_DIRS } from './skills.js';

const MAX_ARCHIVE = 40 * 1024 * 1024;     // compressed download
const MAX_UNPACKED = 80 * 1024 * 1024;    // after gunzip
const MAX_FILES = 4000;
const MAX_SKILL_MD = 120 * 1024;
const MAX_REF_MD = 400 * 1024;
const ALLOWED_HOSTS = new Set(['api.github.com', 'codeload.github.com']);
const MIN_RECHECK_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- tar reader
const cstr = (b, off, len) => { const s = b.subarray(off, off + len); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('utf8'); };

function parsePax(data) {
  const out = {}; let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i); if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString(), 10); if (!len || i + len > data.length) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8'); const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Yields { name, type, data } for each regular file. Handles ustar prefixes, pax and GNU long names. */
export function* tarEntries(buf) {
  let off = 0; let longName = null; let pax = null; let n = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    if (++n > MAX_FILES * 3) throw new Error('The archive has too many entries.');
    let name = cstr(h, 0, 100);
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0 || off + 512 + size > buf.length + 512) throw new Error('The archive is malformed.');
    const type = String.fromCharCode(h[156] || 48);
    if (cstr(h, 257, 5) === 'ustar') { const prefix = cstr(h, 345, 155); if (prefix) name = `${prefix}/${name}`; }
    off += 512; const data = buf.subarray(off, off + size); off += Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = cstr(data, 0, size); continue; }
    if (pax?.path) { name = pax.path; pax = null; } else pax = null;
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '\0') yield { name, type: 'file', data };
  }
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Turn a skills archive into { skills: { name: { files: {relPath: Buffer} } }, rejected: [{path, why}] }. */
export function extractSkills(tgz) {
  let tar; try { tar = zlib.gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED }); } catch (e) { throw new Error(`The archive could not be unpacked: ${e.message}`); }
  const found = {}; const rejected = []; let files = 0;
  for (const e of tarEntries(tar)) {
    const parts = e.name.split('/').filter(Boolean); // <root>/skills/<name>/...
    const i = parts.indexOf('skills'); if (i !== 1 || parts.length < 4) continue;
    if (parts.some((p) => p === '..' || p === '.' || p.includes('\0') || p.includes('\\'))) { rejected.push({ path: e.name, why: 'unsafe path' }); continue; }
    const name = parts[2]; const rel = parts.slice(3).join('/');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) { rejected.push({ path: e.name, why: 'invalid skill name' }); continue; }
    const isSkill = rel === 'SKILL.md'; const isRef = new RegExp(`^(${REF_DIRS.join('|')})/[A-Za-z0-9._-]+\\.md$`).test(rel);
    if (!isSkill && !isRef) continue; // only markdown playbooks; scripts, binaries and everything else are ignored
    if (e.data.length > (isSkill ? MAX_SKILL_MD : MAX_REF_MD)) { rejected.push({ path: e.name, why: 'file too large' }); continue; }
    if (++files > MAX_FILES) throw new Error('The archive has too many skill files.');
    (found[name] ||= { files: {} }).files[rel] = e.data;
  }
  const skills = {};
  for (const [name, s] of Object.entries(found)) {
    const raw = s.files['SKILL.md']; if (!raw) { rejected.push({ path: name, why: 'no SKILL.md' }); continue; }
    const text = raw.toString('utf8'); const m = text.match(FM);
    if (!m) { rejected.push({ path: name, why: 'no frontmatter' }); continue; }
    const meta = {}; for (const line of m[1].split(/\r?\n/)) { const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].replace(/^"|"$/g, ''); }
    if (meta.name !== name) { rejected.push({ path: name, why: `frontmatter name "${meta.name}" does not match the folder` }); continue; }
    if (!meta.description || meta.description.length > 1024) { rejected.push({ path: name, why: 'missing or over-long description' }); continue; }
    if (!m[2].trim()) { rejected.push({ path: name, why: 'empty body' }); continue; }
    skills[name] = { files: s.files, hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12) };
  }
  return { skills, rejected };
}

// ---------------------------------------------------------------- sync
export class SkillSync extends EventEmitter {
  constructor({ id = 'marketing', skills, baseDir, dataDir, repo, branch, mode, apiBase, archiveBase, vendoredCommit, trustBases = false } = {}) {
    super();
    this.id = id; // which library this syncs: 'marketing' or 'hr'
    this.skills = skills; this.baseDir = baseDir; this.dataDir = dataDir;
    this.repo = repo || (id === 'hr' ? process.env.HR_SKILLS_REPO || 'tuanductran/hr-skills' : process.env.SKILLS_REPO || 'coreyhaines31/marketingskills');
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.repo)) throw new Error('SKILLS_REPO must look like owner/name.');
    this.branch = branch || (id === 'hr' ? process.env.HR_SKILLS_BRANCH : process.env.SKILLS_BRANCH) || 'main';
    this.mode = mode || process.env.SKILLS_UPDATE || 'auto'; // auto | ask | off
    this.apiBase = apiBase || process.env.SKILLS_API_BASE || 'https://api.github.com';
    this.archiveBase = archiveBase || process.env.SKILLS_ARCHIVE_BASE || 'https://codeload.github.com';
    const tag = id === 'marketing' ? 'skills-upstream' : `skills-upstream-${id}`;
    this.overlay = path.join(dataDir, tag); this.prev = path.join(dataDir, `${tag}.prev`);
    this.vendoredCommit = vendoredCommit || null;
    this.trustBases = trustBases || !!(process.env.SKILLS_API_BASE || process.env.SKILLS_ARCHIVE_BASE); // an operator-chosen base URL (or a test) is trusted; the defaults are pinned to GitHub
    this.meta = this.readMeta(this.overlay); this.pending = null; this.lastCheck = 0; this.lastError = null; this.lastResult = null; this.busy = null;
  }

  get dirs() { return [{ dir: this.baseDir, source: this.id }, { dir: path.join(this.overlay, 'skills'), source: this.id }]; }
  ownSkills() { return Object.keys(this.skills).filter((n) => (this.skills[n].source || 'marketing') === this.id); }
  get commit() { return this.meta?.commit || this.vendoredCommit; }
  readMeta(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, '.upstream.json'), 'utf8')); } catch { return null; } }

  allowedUrl(u) {
    return this.trustBases || ALLOWED_HOSTS.has(new URL(u).hostname);
  }

  status() {
    return {
      id: this.id, repo: this.repo, branch: this.branch, mode: this.mode, commit: this.commit ? this.commit.slice(0, 7) : null, vendoredCommit: this.vendoredCommit ? this.vendoredCommit.slice(0, 7) : null,
      syncedAt: this.meta?.syncedAt || null, checkedAt: this.lastCheck || null, lastError: this.lastError, canRollback: fs.existsSync(path.join(this.prev, 'skills')) || !!this.meta,
      pending: this.pending ? { commit: this.pending.commit.slice(0, 7), added: this.pending.changes.added, changed: this.pending.changes.changed, removed: this.pending.changes.removed } : null,
      last: this.lastResult, skillCount: this.ownSkills().length,
    };
  }

  async get(url, opts) {
    if (!this.allowedUrl(url)) throw new Error('Refusing to contact a host that is not GitHub.');
    const res = await rawGet(url, 4, opts);
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate-limiting requests right now. Try again later.');
    if (res.status === 404) throw new Error(`Not found on GitHub: ${new URL(url).pathname}`);
    if (res.status >= 400) throw new Error(`GitHub returned HTTP ${res.status}`);
    return res;
  }

  /** Look for a newer commit and, depending on the mode, apply it. Never throws: failures are recorded and reported. */
  check({ force = false, reason = 'manual' } = {}) {
    if (this.mode === 'off' && !force) return Promise.resolve({ result: 'off' });
    if (this.busy) return this.busy;
    if (!force && Date.now() - this.lastCheck < MIN_RECHECK_MS) return Promise.resolve({ ...(this.lastResult || {}), result: 'recent' });
    this.busy = this.run(reason).finally(() => { this.busy = null; });
    return this.busy;
  }

  async run(reason) {
    this.lastCheck = Date.now();
    try {
      const info = await this.get(`${this.apiBase}/repos/${this.repo}/commits/${this.branch}`, { headers: { accept: 'application/vnd.github+json' }, maxBytes: 2_000_000 });
      const sha = JSON.parse(info.body).sha; if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('GitHub did not return a commit.');
      this.lastError = null;
      const cur = this.commit;
      if (cur && (cur.length === 40 ? sha === cur : sha.startsWith(cur))) { this.lastResult = { result: 'up-to-date', commit: sha.slice(0, 7) }; this.emit('checked', this.status()); return this.lastResult; }
      if (this.pending?.commit === sha) return { result: 'pending', commit: sha.slice(0, 7) };
      const tgz = (await this.get(`${this.archiveBase}/${this.repo}/tar.gz/${sha}`, { binary: true, maxBytes: MAX_ARCHIVE })).body;
      const { skills: up, rejected } = extractSkills(tgz);
      if (!Object.keys(up).length) throw new Error('The archive contained no valid skills, so nothing was changed.');
      const changes = { added: [], changed: [], removed: [] };
      for (const [n, s] of Object.entries(up)) { if (!this.skills[n]) changes.added.push(n); else if (this.skills[n].hash !== s.hash) changes.changed.push(n); }
      for (const n of this.ownSkills()) if (!up[n]) changes.removed.push(n); // kept locally: upstream removal does not delete a working playbook
      const pkg = { commit: sha, up, changes, rejected, reason };
      if (this.mode === 'ask' && (changes.added.length || changes.changed.length)) { this.pending = pkg; this.lastResult = { result: 'update-available', commit: sha.slice(0, 7), ...changes, rejected: rejected.length }; this.emit('pending', this.status()); return this.lastResult; }
      return this.apply(pkg);
    } catch (e) {
      this.lastError = String(e.message || e); this.lastResult = { result: 'error', error: this.lastError }; this.emit('error_', this.lastError); return this.lastResult;
    }
  }

  apply(pkg) {
    const { commit, up, changes, rejected } = pkg;
    // keep the previous overlay so this can be undone
    fs.rmSync(this.prev, { recursive: true, force: true });
    if (fs.existsSync(this.overlay)) fs.renameSync(this.overlay, this.prev);
    const root = path.join(this.overlay, 'skills');
    for (const [name, s] of Object.entries(up)) for (const [rel, data] of Object.entries(s.files)) {
      const dest = path.join(root, name, rel);
      if (!dest.startsWith(root + path.sep)) continue; // belt and braces: never write outside the overlay
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data);
    }
    this.meta = { repo: this.repo, branch: this.branch, commit, syncedAt: Date.now(), ...changes, rejected: rejected.map((r) => `${r.path}: ${r.why}`).slice(0, 20) };
    fs.writeFileSync(path.join(this.overlay, '.upstream.json'), JSON.stringify(this.meta));
    const diff = reloadSkills(this.skills, this.dirs);
    this.pending = null;
    this.lastResult = { result: changes.added.length || changes.changed.length ? 'updated' : 'up-to-date', commit: commit.slice(0, 7), added: diff.added, changed: diff.changed, removed: changes.removed, rejected: rejected.length };
    if (diff.added.length || diff.changed.length) this.emit('updated', { ...this.lastResult, status: this.status() });
    return this.lastResult;
  }

  approve() { if (!this.pending) return { result: 'none' }; return this.apply(this.pending); }
  decline() { const p = this.pending; this.pending = null; if (p) this.lastResult = { result: 'declined', commit: p.commit.slice(0, 7) }; return this.lastResult; }

  /** Undo the last applied update (back to the previous overlay, or to the vendored copy). */
  rollback() {
    const had = this.meta;
    fs.rmSync(this.overlay, { recursive: true, force: true });
    if (fs.existsSync(this.prev)) fs.renameSync(this.prev, this.overlay);
    this.meta = this.readMeta(this.overlay);
    const diff = reloadSkills(this.skills, this.dirs, { prune: true, source: this.id });
    this.lastResult = { result: 'rolled-back', commit: (this.commit || '').slice(0, 7), changed: diff.changed, removed: diff.removed, added: diff.added };
    this.emit('updated', { ...this.lastResult, status: this.status() });
    return { rolledBack: !!had, ...this.lastResult };
  }
}

export { loadSkills };
