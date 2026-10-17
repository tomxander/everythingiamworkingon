// The models the picker offers, with list prices (USD per million tokens, Anthropic first-party API).
// The live list comes from the Models API when an API key is set; this table supplies prices and a
// sensible order, and is the whole list in Claude account mode. Prices last checked 2026-10-06.
// God's rule: nothing costlier than Sonnet. Opus and Fable are never offered or used.
export const isAllowedModel = (id) => /^claude-(sonnet|haiku)-/.test(String(id || ''));
export const MODEL_CATALOG = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', in: 2, out: 10, tier: 'recommended', note: 'Strong writing and judgement. The default.' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', in: 0.1, out: 0.5, tier: 'recommended', note: 'Fastest and cheapest. Best for short, structured work.' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', in: 2, out: 10, tier: 'older' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', in: 3, out: 15, tier: 'older' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', in: 1, out: 5, tier: 'older' },
];
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
/** Short replies in meetings, chat and quick questions: quality matters less than speed and cost. */
export const LIGHT_MODEL = 'claude-haiku-5-5';
export const LIGHT_KINDS = new Set(['chat', 'kickoff_reply', 'align_reply', 'consult_q', 'consult_a', 'escalate_reply', 'hire']);

/**
 * The suggested model for each person. Sonnet for anyone who plans, decides, reviews others or writes the long
 * deliverables; Haiku for work that is short and structured, where Sonnet costs twenty times more for little gain.
 */
const HAIKU_ROLES = {
  kenji: 'Writes short community and social posts, where speed matters more than depth.',
  dee: 'Produces structured tracking plans, event lists and test set-ups.',
  tomas: 'Maps skills and job data into structured lists and tables.',
};
export function suggestedModel(a) {
  if (HAIKU_ROLES[a.id]) return { model: 'claude-haiku-5-5', why: HAIKU_ROLES[a.id] };
  if (a.id === 'vera') return { model: 'claude-sonnet-5-5', why: 'Plans every task, decides between options and writes the final summary.' };
  if (a.lead) return { model: 'claude-sonnet-5-5', why: 'Leads a team and reviews other people\'s work, so judgement matters.' };
  if (a.hired) return { model: 'claude-sonnet-5-5', why: 'Hired for expertise the team lacked, so their work needs depth.' };
  return { model: 'claude-sonnet-5-5', why: 'Writes long, client-facing deliverables where quality shows.' };
}

export const catalogEntry = (id) => MODEL_CATALOG.find((m) => m.id === id) || null;

/**
 * Merge the live Models API list with the catalog: catalog models first (in its order) when the account has them,
 * then any other model the account offers. Without a live list, the catalog is the list.
 */
export function mergeModels(live) {
  if (!live?.length) return MODEL_CATALOG.map((m) => ({ ...m, available: null }));
  live = live.filter((m) => isAllowedModel(m.id));
  const byId = new Map(live.map((m) => [m.id, m]));
  const known = MODEL_CATALOG.filter((m) => byId.has(m.id)).map((m) => ({ ...m, name: byId.get(m.id).display_name || m.name, available: true }));
  const extra = live.filter((m) => !catalogEntry(m.id)).map((m) => ({ id: m.id, name: m.display_name || m.id, in: null, out: null, tier: 'other', available: true }));
  return [...known, ...extra];
}
