// Loads the marketingskills library from vendor/ (or SKILLS_DIR) and gives
// agents their expertise.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = process.env.SKILLS_DIR || path.join(here, '..', 'vendor', 'marketingskills', 'skills');
export const HR_SKILLS_DIR = process.env.HR_SKILLS_DIR || path.join(here, '..', 'vendor', 'hr-skills', 'skills');
// subfolders of a skill that hold reference material an agent can open on demand (marketingskills: references/, hr-skills: content/ examples/ prompts/)
export const REF_DIRS = ['references', 'content', 'examples', 'prompts'];

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^"|"$/g, '');
  }
  return { meta, body: m[2] };
}

/**
 * Load skills from one or more layers: a directory, or { dir, source }. Later layers override earlier ones
 * (an upstream overlay wins over the vendored copy). `source` says which library a skill belongs to.
 */
export function loadSkills(layers = SKILLS_DIR) {
  const skills = {};
  for (const layer of [].concat(layers)) {
    const dir = typeof layer === 'string' ? layer : layer?.dir; const source = (typeof layer === 'object' && layer?.source) || 'marketing';
    if (!dir || !fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const references = [];
      for (const sub of REF_DIRS) { const refDir = path.join(dir, name, sub); if (fs.existsSync(refDir)) for (const f of fs.readdirSync(refDir).sort()) if (f.endsWith('.md')) references.push(`${sub}/${f}`); }
      const title = (body.match(/^#\s+(.+)$/m) || [null, name])[1].trim();
      const description = (meta.description || '').trim();
      skills[name] = {
        name, title, description, source,
        summary: description.replace(/^When the user (wants to )?/i, '').split(/\. /)[0].slice(0, 140),
        body, references, dir: path.join(dir, name), hash: crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12),
      };
    }
  }
  return skills;
}

/** Refresh `target` in place from disk, so everything holding a reference sees the update. */
export function reloadSkills(target, layers, { prune = false, source = null } = {}) {
  const fresh = loadSkills(layers); const added = [], changed = [], removed = [];
  for (const [k, v] of Object.entries(fresh)) { if (!target[k]) added.push(k); else if (target[k].hash !== v.hash) changed.push(k); target[k] = v; }
  if (prune) for (const k of Object.keys(target)) if (!fresh[k] && (!source || target[k].source === source)) { removed.push(k); delete target[k]; } // only prune the library that was rolled back
  return { added, changed, removed };
}

const STOP = new Set('the a an and or of to for in on with is are be this that it as at by from your our their you we can use used using help want wants user when also'.split(' '));
export const tokenize = (s) => (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]+/g) || []).filter((w) => !STOP.has(w) && w.length > 2);

// Pick the best skill from `candidates` for a free-text brief.
export function bestSkill(skills, candidates, text) {
  const words = new Set(tokenize(text));
  let best = candidates[0]; let bestScore = -1;
  for (const c of candidates) {
    const s = skills[c]; if (!s) continue;
    const hay = tokenize(`${c.replace(/-/g, ' ')} ${s.description}`);
    let score = 0;
    for (const w of hay) if (words.has(w)) score += 1;
    for (const w of c.split('-')) if (words.has(w)) score += 6;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// The text that becomes an agent's expertise in the system prompt.
export function skillPrompt(skill, maxChars = 22000) {
  if (!skill) return '';
  let body = skill.body.trim();
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n\n[... skill truncated for length ...]';
  const refs = skill.references.length ? `\n\n(Reference files available in the library for this skill: ${skill.references.join(', ')}.)` : '';
  return `# Your active skill: ${skill.name}\n\n${body}${refs}`;
}

/**
 * Rank library skills against a free-text need. Words are weighted by how rare they are across the
 * library (a word like "marketing" is in most skills and tells you nothing; "marine" tells you a lot),
 * and a match in the skill's name or title counts three times a match in its description.
 */
export function rankSkills(skills, text, limit = 5, universe = skills) {
  const words = new Set(tokenize(text)); if (!words.size) return [];
  const mk = (s) => ({ s, head: new Set(tokenize(`${s.name.replace(/-/g, ' ')} ${s.title}`)), desc: new Set(tokenize(s.description)) });
  const all = Object.values(universe); const N = all.length || 1; // word rarity is judged across the whole library, even when ranking only a subset
  const docs = Object.values(skills).map(mk);
  const df = {}; for (const d of all.map(mk)) for (const w of new Set([...d.head, ...d.desc])) df[w] = (df[w] || 0) + 1;
  const idf = (w) => Math.log((N + 1) / ((df[w] || 0) + 0.5));
  return docs.map(({ s, head, desc }) => {
    let score = 0;
    for (const w of words) { if (head.has(w)) score += 3 * idf(w); else if (desc.has(w)) score += idf(w); }
    return { name: s.name, title: s.title, score: Number(score.toFixed(2)) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function skillIndex(skills) {
  return Object.values(skills).map((s) => ({ name: s.name, title: s.title, summary: s.summary, references: s.references.length, source: s.source || 'marketing' }));
}
