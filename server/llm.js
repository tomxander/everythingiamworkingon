// LLM gateway: real Claude calls when a key is available, a believable
// simulator when it is not. Everything above this layer is identical in
// both modes.
import { mockComplete } from './mock.js';

const API_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
// Pricing is a user-supplied estimate (USD per million tokens). Defaults are placeholders; set PRICE_IN / PRICE_OUT.
const PRICE_IN = Number(process.env.PRICE_IN ?? 3);
const PRICE_OUT = Number(process.env.PRICE_OUT ?? 15);

export class LLM {
  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || '';
    this.model = process.env.MODEL || 'claude-sonnet-5-5';
    this.mode = this.apiKey ? 'live' : 'mock';
    this.totals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0, simulated: this.mode === 'mock' };
    this.lastError = null;
  }

  status() {
    return { mode: this.mode, hasKey: !!this.apiKey, model: this.model, totals: { ...this.totals }, lastError: this.lastError, price: { in: PRICE_IN, out: PRICE_OUT } };
  }

  setKey(key) {
    this.apiKey = (key || '').trim();
    if (!this.apiKey && this.mode === 'live') this.mode = 'mock';
    return this.status();
  }

  setMode(mode) {
    if (mode === 'live' && !this.apiKey) throw new Error('No API key set. Add one in Settings first.');
    this.mode = mode === 'live' ? 'live' : 'mock';
    this.totals.simulated = this.mode === 'mock';
    return this.status();
  }

  setModel(model) { if (model) this.model = model; }

  account(inTok, outTok, cacheRead = 0) {
    this.totals.calls++;
    this.totals.inputTokens += inTok; this.totals.outputTokens += outTok; this.totals.cacheReadTokens += cacheRead;
    this.totals.cost += (inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6;
  }

  /**
   * kind: plan | work | consult_q | consult_a | review | synth
   * ctx:  structured info (used by the simulator; ignored in live mode)
   * system: string | string[]; the last block is cached when long
   */
  async complete({ kind, system, user, maxTokens = 1500, ctx = {} }) {
    if (this.mode === 'mock') {
      const out = mockComplete(kind, ctx);
      const inTok = Math.ceil(((Array.isArray(system) ? system.join('') : system || '').length + (user || '').length) / 4);
      const outTok = Math.ceil(out.text.length / 4);
      this.account(inTok, outTok);
      return { text: out.text, headline: out.headline, latencyMs: out.latencyMs, usage: { input: inTok, output: outTok }, simulated: true };
    }
    return this.live({ system, user, maxTokens });
  }

  async live({ system, user, maxTokens }) {
    const blocks = (Array.isArray(system) ? system : [system]).filter(Boolean).map((t, i, arr) => {
      const b = { type: 'text', text: t };
      if (i === arr.length - 1 && t.length > 4000) b.cache_control = { type: 'ephemeral' };
      return b;
    });
    const body = { model: this.model, max_tokens: maxTokens, system: blocks, messages: [{ role: 'user', content: user }] };
    let lastErr;
    const started = Date.now();
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${API_URL}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`API ${res.status}`);
          await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
          continue;
        }
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || `API ${res.status}`);
        const text = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
        const u = json.usage || {};
        const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        this.account(input, u.output_tokens || 0, u.cache_read_input_tokens || 0);
        this.lastError = null;
        return { text, latencyMs: Date.now() - started, usage: { input, output: u.output_tokens || 0 }, simulated: false };
      } catch (e) {
        lastErr = e;
        if (/API (4\d\d)|invalid|authentication|credit/i.test(String(e.message)) && !/429/.test(e.message)) break;
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      }
    }
    this.lastError = String(lastErr?.message || lastErr);
    throw lastErr;
  }
}

// Pull a JSON object/array out of a model reply, tolerating code fences and chatter.
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[\[{]/);
    if (start < 0) continue;
    for (let end = c.length; end > start; end--) {
      const ch = c[end - 1];
      if (ch !== '}' && ch !== ']') continue;
      try { return JSON.parse(c.slice(start, end)); } catch { /* keep shrinking */ }
    }
  }
  return null;
}
