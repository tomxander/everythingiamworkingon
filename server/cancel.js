// Stopping a task. Each running task gets an AbortSignal held in an AsyncLocalStorage scope, so every model call made
// on its behalf (planning, work, reviews, meetings, tool loops) sees it without being passed it explicitly.
import { AsyncLocalStorage } from 'node:async_hooks';

export const taskScope = new AsyncLocalStorage();
export class Cancelled extends Error { constructor(msg = 'Stopped by God.') { super(msg); this.cancelled = true; } }
export const currentSignal = () => taskScope.getStore()?.signal || null;
export function throwIfCancelled(signal) { if (signal?.aborted) throw new Cancelled(); }
/** Sleep that ends early (with Cancelled) when the signal fires. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Cancelled()); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
