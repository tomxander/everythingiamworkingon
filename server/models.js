// The models the picker offers, with list prices (USD per million tokens, Anthropic first-party API).
// The live list comes from the Models API when an API key is set; this table supplies prices and a
// sensible order, and is the whole list in Claude account mode. Prices last checked 2026-10-06.
export const MODEL_CATALOG = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', in: 4, out: 20, tier: 'recommended', note: 'Most capable Opus. The default.' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', in: 2, out: 10, tier: 'recommended', note: 'Fast and strong, half the price of Opus.' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', in: 0.1, out: 0.5, tier: 'recommended', note: 'Fastest and cheapest. Best for light work.' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', in: 10, out: 50, tier: 'recommended', note: 'Most capable overall. Slower and the most expensive.' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', in: 5, out: 25, tier: 'older' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', in: 2, out: 10, tier: 'older' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', in: 10, out: 50, tier: 'older' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', in: 5, out: 25, tier: 'older' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', in: 5, out: 25, tier: 'older' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', in: 3, out: 15, tier: 'older' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', in: 1, out: 5, tier: 'older' },
];
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const catalogEntry = (id) => MODEL_CATALOG.find((m) => m.id === id) || null;

/**
 * Merge the live Models API list with the catalog: catalog models first (in its order) when the account has them,
 * then any other model the account offers. Without a live list, the catalog is the list.
 */
export function mergeModels(live) {
  if (!live?.length) return MODEL_CATALOG.map((m) => ({ ...m, available: null }));
  const byId = new Map(live.map((m) => [m.id, m]));
  const known = MODEL_CATALOG.filter((m) => byId.has(m.id)).map((m) => ({ ...m, name: byId.get(m.id).display_name || m.name, available: true }));
  const extra = live.filter((m) => !catalogEntry(m.id)).map((m) => ({ id: m.id, name: m.display_name || m.id, in: null, out: null, tier: 'other', available: true }));
  return [...known, ...extra];
}
