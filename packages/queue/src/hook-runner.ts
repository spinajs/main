import { DI } from '@spinajs/di';
import { QueueMessageHook } from './hooks.js';
import { QueueTrackingHook } from './tracking-hook.js';
import type { IQueueMessage } from './interfaces.js';

// Resolved on every call: the hooks an app registers may come after the service was created.
async function hooks(): Promise<QueueMessageHook[]> {
  return (await DI.resolve(Array.ofType(QueueMessageHook))) ?? [];
}

export async function runBeforeEmit(message: IQueueMessage): Promise<void> {
  for (const hook of await hooks()) {
    await hook.beforeEmit(message);
  }
}

/** Runs `fn` (which builds and executes its queries) through every QueueTrackingHook; the first registered is outermost. */
export async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  const chain = (await DI.resolve(Array.ofType(QueueTrackingHook))) ?? [];
  return chain.reduceRight<() => Promise<T>>((next, hook) => () => hook.aroundTracking(next), fn)();
}

/** The first registered hook is the outermost. */
export async function runAroundHandle<T>(message: IQueueMessage, execute: () => Promise<T>): Promise<T> {
  const chain = await hooks();
  const run = chain.reduceRight<() => Promise<T>>((next, hook) => () => hook.aroundHandle(message, next), execute);
  return run();
}
