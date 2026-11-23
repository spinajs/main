import { DI } from '@spinajs/di';
import { QueueMessageHook } from './hooks.js';
import { QueueTrackingHook } from './tracking-hook.js';
import type { IQueueMessage } from './interfaces.js';

// Resolved on every call: the hooks an app registers may come after the service was created.
async function hooks(): Promise<QueueMessageHook[]> {
  const registered: QueueMessageHook[] = (await DI.resolve(Array.ofType(QueueMessageHook))) ?? [];
  // Array.prototype.sort is stable, so hooks of one order keep their registration order.
  return [...registered].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** The reverse of the handle chain: the outermost hook writes last, so what it restores on handling is what it stamped. */
export async function runBeforeEmit(message: IQueueMessage): Promise<void> {
  for (const hook of (await hooks()).reverse()) {
    await hook.beforeEmit(message);
  }
}

/** Runs `fn` (which builds and executes its queries) through every QueueTrackingHook; the first registered is outermost. */
export async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  const chain = (await DI.resolve(Array.ofType(QueueTrackingHook))) ?? [];
  return chain.reduceRight<() => Promise<T>>((next, hook) => () => hook.aroundTracking(next), fn)();
}

/** The hook of the lowest order is the outermost; among hooks of one order, the first registered. */
export async function runAroundHandle<T>(message: IQueueMessage, execute: () => Promise<T>): Promise<T> {
  const chain = await hooks();
  const run = chain.reduceRight<() => Promise<T>>((next, hook) => () => hook.aroundHandle(message, next), execute);
  return run();
}
