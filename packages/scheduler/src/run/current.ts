import { AsyncLocalStorage } from 'async_hooks';
import type { RunContext } from './RunContext.js';

const storage = new AsyncLocalStorage<RunContext>();

/** The context of the run on this async path, for task code that cannot take it as a parameter. */
export function currentRunContext(): RunContext | undefined {
  return storage.getStore();
}

export function withRunContext<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}
