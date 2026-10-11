import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { buildMap } from '../server/map.js';
import { AGENTS } from '../server/roster.js';
import { loadSkills, SKILLS_DIR, HR_SKILLS_DIR } from '../server/skills.js';
import { Sim } from '../server/sim.js';
import { Life } from '../server/life.js';
import { LLM } from '../server/llm.js';
import { Company } from '../server/company.js';

export function world({ life = false, learning = 'passive', web = false, collab = 'full', hiring = 'auto', syncFor = null, outside = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4evr-'));
  const map = buildMap();
  const skills = loadSkills([{ dir: SKILLS_DIR, source: 'marketing' }, { dir: HR_SKILLS_DIR, source: 'hr' }]);
  const sync = syncFor ? syncFor(skills, tmp) : null;
  const llm = new LLM(); llm.apiKey = ''; llm.mode = 'mock';
  const sim = new Sim(map, AGENTS);
  const company = new Company({ sim, llm, skills, dataDir: path.join(tmp, 'data'), deliverablesDir: path.join(tmp, 'deliverables') });
  const l = new Life(sim, company);
  company.skillIndexFn = () => Object.values(skills).map((s) => ({ name: s.name }));
  if (sync) company.attachSkillSync(sync);
  company.life = l; company.webResearch = web; company.kb.mode = learning; company.collab = collab; company.outsideResearch = outside; company.hiringMode = hiring;
  if (life) l.start();
  return { map, skills, llm, sim, company, life: l, tmp, sync };
}

/** Advance the simulation faster than real time until `done()` or the sim-time budget runs out. */
export async function run(sim, done, maxSimSec = 600, step = 0.1) {
  const end = sim.time + maxSimSec;
  while (!done() && sim.time < end) {
    sim.tick(step);
    await new Promise((r) => setImmediate(r));
  }
  return done();
}
