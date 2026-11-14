import { AsyncLocalStorage } from 'node:async_hooks';

/** One incarnation of a replica. A restart after a crash is a new process, so a new incarnation. */
export interface SimContext {
  readonly replica: string;
  readonly incarnation: number;
}

const storage = new AsyncLocalStorage<SimContext>();

export function currentContext(): SimContext | undefined {
  return storage.getStore();
}

export function runInContext<T>(ctx: SimContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function ownerKey(ctx: SimContext): string {
  return `${ctx.replica}#${ctx.incarnation}`;
}

/** The id an engine instance of the calling incarnation registers under, eg. `relay-1.2`. */
export function currentReplicaId(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('currentReplicaId: called outside a simulated replica');
  return `${ctx.replica}.${ctx.incarnation}`;
}
