// Each person has a suggested model suited to their job (Sonnet at most), light chatter goes to Haiku, and God can override anyone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { MODEL_CATALOG, DEFAULT_MODEL, LIGHT_MODEL, mergeModels, isAllowedModel } from '../server/models.js';
import { LLM } from '../server/llm.js';

const SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5';

test('only Sonnet and Haiku models are offered or accepted, and Sonnet 5.5 is the default', () => {
  assert.equal(DEFAULT_MODEL, SONNET); assert.equal(LIGHT_MODEL, HAIKU);
  assert.ok(MODEL_CATALOG.length && MODEL_CATALOG.every((m) => /sonnet|haiku/.test(m.id)), MODEL_CATALOG.map((m) => m.id).join());
  for (const id of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-opus-6']) assert.ok(!isAllowedModel(id), id);
  const merged = mergeModels([{ id: 'claude-opus-5-5' }, { id: SONNET }, { id: 'claude-opus-6' }, { id: 'claude-haiku-6' }]);
  assert.deepEqual(merged.map((m) => m.id), [SONNET, 'claude-haiku-6'], 'costlier models from the account list are left out');
  const l = new LLM(); assert.throws(() => l.setModel('claude-opus-5-5'), /Sonnet/);
  const prev = process.env.MODEL; process.env.MODEL = 'claude-opus-5-5';
  try { assert.equal(new LLM().model, SONNET, 'an Opus MODEL variable falls back to the default'); } finally { if (prev === undefined) delete process.env.MODEL; else process.env.MODEL = prev; }
});

test('everyone has a suggested model that fits their job, with a reason', () => {
  const w = world(); const c = w.company;
  const all = [...w.sim.agents.values()].map((a) => [a.id, c.agentModel(a.id)]);
  for (const [id, m] of all) { assert.ok(isAllowedModel(m.suggested), `${id}: ${m.suggested}`); assert.ok(m.why && m.why.length > 10, `${id} has a reason`); assert.equal(m.choice, null); }
  assert.equal(c.agentModel('vera').suggested, SONNET, 'the CMO plans and decides');
  assert.equal(c.agentModel('kenji').suggested, HAIKU, 'short social and community work');
  assert.ok(all.some(([, m]) => m.suggested === SONNET) && all.some(([, m]) => m.suggested === HAIKU), 'both models are used');
});

test('the right model is used for each call: the person\'s model for real work, Haiku for light chatter', () => {
  const w = world(); const c = w.company;
  assert.equal(c.modelFor('vera', 'plan'), SONNET); assert.equal(c.modelFor('vera', 'review'), SONNET);
  assert.equal(c.modelFor('vera', 'chat'), HAIKU); assert.equal(c.modelFor('theo', 'kickoff_reply'), HAIKU);
  assert.equal(c.modelFor('kenji', 'work'), HAIKU);
  assert.equal(c.modelFor(null, 'resolve'), w.llm.model, 'calls that belong to nobody use the default');
  assert.equal(c.modelFor('someone-who-left', 'work'), w.llm.model);
});

test('God can change anyone\'s model (never above Sonnet), reset it, and the choice is remembered', () => {
  const w = world(); const c = w.company;
  c.setAgentModel('kenji', SONNET); assert.equal(c.modelFor('kenji', 'work'), SONNET); assert.equal(c.agentModel('kenji').choice, SONNET);
  assert.equal(c.publicAgent(c.agent('kenji')).model.current, SONNET, 'the interface sees it');
  assert.throws(() => c.setAgentModel('kenji', 'claude-opus-5-5'), /Sonnet/);
  assert.throws(() => c.setAgentModel('nobody', SONNET), /No such person/);
  c.setAgentModel('theo', HAIKU); c.save();
  const w2 = world(); w2.company.dataDir = c.dataDir; w2.company.kb.dir = c.dataDir; assert.ok(w2.company.load());
  assert.equal(w2.company.modelFor('kenji', 'work'), SONNET); assert.equal(w2.company.modelFor('theo', 'work'), HAIKU);
  w2.company.setAgentModel('kenji', null); assert.equal(w2.company.modelFor('kenji', 'work'), HAIKU, 'reset goes back to the suggestion');
});

test('cost is counted at the price of the model that made the call', () => {
  const l = new LLM();
  l.account(1e6, 0, 0, true, HAIKU); assert.equal(Number(l.totals.spent.toFixed(4)), 0.1);
  l.account(1e6, 0, 0, true, SONNET); assert.equal(Number(l.totals.spent.toFixed(4)), 2.1);
});

test('every model call says who is making it, so it runs on that person\'s model', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server'); const missing = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8'); let i = -1;
    while ((i = src.indexOf('llm.complete({', i + 1)) >= 0) {
      const call = src.slice(i, i + 700); const line = src.slice(0, i).split('\n').length;
      if (/kind: '(resolve|test)'/.test(call)) continue; // connector lookups and the connection test belong to nobody
      if (!/toolkit\(|agent: |\.\.\.tk\d?\b/.test(call)) missing.push(`${f}:${line}`);
    }
  }
  assert.deepEqual(missing, [], 'calls without an agent fall back to the default model');
});
