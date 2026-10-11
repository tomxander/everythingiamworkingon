// Loads the marketingskills library from vendor/ (or SKILLS_DIR) and gives
// agents their expertise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = process.env.SKILLS_DIR || path.join(here, '..', 'vendor', 'marketingskills', 'skills');

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

export function loadSkills(dir = SKILLS_DIR) {
  const skills = {};
  if (!fs.existsSync(dir)) return skills;
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const refDir = path.join(dir, name, 'references');
    const references = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter((f) => f.endsWith('.md')).sort() : [];
    const title = (body.match(/^#\s+(.+)$/m) || [null, name])[1].trim();
    // "description" is long trigger text; keep a short human summary too
    const description = (meta.description || '').trim();
    skills[name] = {
      name, title, description,
      summary: description.replace(/^When the user (wants to )?/i, '').split(/\. /)[0].slice(0, 140),
      body, references, dir: path.join(dir, name),
    };
  }
  return skills;
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

export function skillIndex(skills) {
  return Object.values(skills).map((s) => ({ name: s.name, title: s.title, summary: s.summary, references: s.references.length }));
}
