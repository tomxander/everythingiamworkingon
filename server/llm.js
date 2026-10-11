// LLM gateway: real Claude calls when a key is available, a believable
// simulator when it is not. Everything above this layer is identical in
// both modes.
import { mockComplete } from './mock.js';

const API_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
// Pricing is a user-supplied estimate (USD per million tokens). Defaults are placeholders; set PRICE_IN / PRICE_OUT.
const PRICE_IN = Number(process.env.PRICE_IN ?? 3);
const PRICE_OUT = Number(process.env.PRICE_OUT ?? 15);
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 180000);

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
   * kind: plan | work | consult_q | consult_a | review | synth | intake | profile | revise | chat
   * ctx:  structured info (used by the simulator; ignored in live mode)
   * system: string | string[]; the last block is cached when long
   * tools/onTool: optional tool use (live mode only). onTool(name, input) -> string
   */
  async complete({ kind, system, user, maxTokens = 1500, ctx = {}, tools = null, onTool = null, maxTurns = 6 }) {
    if (this.mode === 'mock') {
      const out = mockComplete(kind, ctx);
      const inTok = Math.ceil(((Array.isArray(system) ? system.join('') : system || '').length + (user || '').length) / 4);
      const outTok = Math.ceil(out.text.length / 4);
      this.account(inTok, outTok);
      return { text: out.text, headline: out.headline, latencyMs: out.latencyMs, usage: { input: inTok, output: outTok }, simulated: true, toolCalls: 0 };
    }
    return this.live({ system, user, maxTokens, tools, onTool, maxTurns });
  }

  async live({ system, user, maxTokens, tools, onTool, maxTurns }) {
    const blocks = (Array.isArray(system) ? system : [system]).filter(Boolean).map((t, i, arr) => {
      const b = { type: 'text', text: t };
      if (i === arr.length - 1 && t.length > 4000) b.cache_control = { type: 'ephemeral' };
      return b;
    });
    const messages = [{ role: 'user', content: user }];
    const started = Date.now();
    let inTotal = 0, outTotal = 0, toolCalls = 0, text = '', continued = false;
    for (let turn = 0; turn < maxTurns + 3; turn++) {
      const useTools = tools && onTool && toolCalls < maxTurns * 2 && turn < maxTurns;
      const body = { model: this.model, max_tokens: maxTokens, system: blocks, messages };
      if (useTools) body.tools = tools;
      const json = await this.apiCall(body);
      const u = json.usage || {};
      const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      inTotal += input; outTotal += u.output_tokens || 0;
      this.account(input, u.output_tokens || 0, u.cache_read_input_tokens || 0);
      const content = json.content || [];
      const chunk = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (json.stop_reason === 'tool_use' && useTools) {
        messages.push({ role: 'assistant', content });
        const results = [];
        for (const c of content.filter((x) => x.type === 'tool_use')) {
          toolCalls++;
          let out; try { out = String(await onTool(c.name, c.input || {})); } catch (e) { out = `Tool error: ${e.message}`; }
          results.push({ type: 'tool_result', tool_use_id: c.id, content: out.slice(0, 30000) });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      if (json.stop_reason === 'tool_use' && !useTools) {
        // out of tool budget: ask for the answer with what it has
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: (content.filter((x) => x.type === 'tool_use').map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'Tool budget used up. Write the final answer now with the information you already have, and say what you could not verify.' }))) });
        continue;
      }
      text = text ? `${text}\n${chunk}` : chunk;
      if (json.stop_reason === 'max_tokens' && !continued) {
        // the answer was cut off: ask it to carry on from exactly where it stopped
        continued = true;
        messages.push({ role: 'assistant', content: [{ type: 'text', text: chunk || '...' }] });
        messages.push({ role: 'user', content: 'You were cut off. Continue exactly where you stopped, without repeating anything and without a preamble.' });
        continue;
      }
      this.lastError = null;
      return { text: text.trim(), latencyMs: Date.now() - started, usage: { input: inTotal, output: outTotal }, simulated: false, toolCalls, truncated: json.stop_reason === 'max_tokens' };
    }
    this.lastError = 'The model kept requesting tools without answering.';
    throw new Error(this.lastError);
  }

  async apiCall(body) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${API_URL}/v1/messages`, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`API ${res.status}`);
          const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, Math.min(wait, 20000)));
          continue;
        }
        const json = await res.json();
        if (!res.ok) { const err = new Error(json?.error?.message || `API ${res.status}`); err.fatal = true; throw err; }
        return json;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error(`The API did not answer within ${TIMEOUT_MS / 1000}s`) : e;
        if (e.fatal) break;
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      } finally { clearTimeout(timer); }
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
