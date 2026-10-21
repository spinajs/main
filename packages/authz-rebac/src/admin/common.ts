import { AuthzAdminFailure, AuthzConfigError, adminActor, adminContainer, memoryTx } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, PrincipalRef } from '@spinajs/authz';

import { TupleStore } from '../contracts.js';
import type { Tuple, TupleSubject } from '../contracts.js';
import { readTuple } from '../keys.js';
import { RebacModel } from '../model/model.js';
import { DbTupleStore } from '../stores/db.js';
import { MemoryTupleStore } from '../stores/memory.js';

export type WritableTupleStore = MemoryTupleStore | DbTupleStore;

const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

/**
 * The one MemoryTupleStore or DbTupleStore registered as TupleStore in the domain. None: AuthzConfigError,
 * or undefined when not `required`. Two: AuthzConfigError, since a command could not tell which one the
 * RebacModel reads.
 */
export async function writableStore(ctx: AdminContext): Promise<WritableTupleStore>;
export async function writableStore(ctx: AdminContext, required: false): Promise<WritableTupleStore | undefined>;
export async function writableStore(ctx: AdminContext, required = true): Promise<WritableTupleStore | undefined> {
  const container = adminContainer(ctx);
  const where = `Authz domain ${q(ctx.domain)}`;
  const stores = container.hasRegistered(TupleStore) ? [...(await container.resolve(Array.chainOf(TupleStore)))] : [];
  const writable = [...new Set(stores.filter((s): s is WritableTupleStore => s instanceof MemoryTupleStore || s instanceof DbTupleStore))];
  if (writable.length > 1) throw new AuthzConfigError(`${where}: more than one writable TupleStore is registered (${writable.map((s) => s.constructor.name).join(', ')}); register only the one the RebacModel reads`);
  if (writable.length === 0 && required) throw new AuthzConfigError(`${where}: no MemoryTupleStore or DbTupleStore is registered as TupleStore; the tuple commands of AuthzAdmin write to the one the domain's RebacModel reads`);
  return writable[0];
}

export const rebacModels = (ctx: AdminContext): RebacModel[] => ctx.authz.models().filter((m): m is RebacModel => m instanceof RebacModel);

export function actorRef(ctx: AdminContext): PrincipalRef {
  const a = adminActor(ctx);
  return { type: a.type, id: a.id };
}

/** A tuple a command carries, as a plain copy; a malformed one is `invalid_command`. */
export function commandTuple(v: unknown): Tuple {
  try {
    return readTuple(v, 'tuple');
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    throw new AuthzAdminFailure('invalid_command', e.message, 'tuple', { cause: e });
  }
}

/** A subject a query filters by; a malformed one is `invalid_query`. */
export function querySubject(v: unknown): TupleSubject {
  try {
    return readTuple({ object: { type: 'q', id: 'q' }, relation: 'q', subject: v }, 'query').subject;
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    throw new AuthzAdminFailure('invalid_query', 'subject must be a principal { type, id } or a subject set { object: { type, id }, relation }', 'subject', { cause: e });
  }
}

/** The tags a change of tuples in `namespaces` publishes: the models of the domain reload, the caches of their votes drop. */
export function tupleTags(ctx: AdminContext, namespaces: Iterable<string>): string[] {
  return [...new Set(['rebac', ...[...namespaces].map((n) => `rebac:${n}`), ...rebacModels(ctx).map((m) => `model:${m.name}`)])];
}

export function tupleChanged(ctx: AdminContext, tuple: Tuple, op: 'write' | 'delete'): AuthzEvent {
  return { type: 'TupleChanged', domain: ctx.domain, actor: actorRef(ctx), at: ctx.now, data: { object: tuple.object, relation: tuple.relation, subject: tuple.subject, op } };
}

/** Adds and removes in the store inside `tx`; memory writes register their undo. Returns what changed. */
export async function writeTuples(store: WritableTupleStore, tx: AuthzTx, add: readonly Tuple[], remove: readonly Tuple[], ctx: AdminContext): Promise<{ readonly added: readonly Tuple[]; readonly removed: readonly Tuple[] }> {
  const actor = actorRef(ctx);
  if (store instanceof DbTupleStore) {
    // writeIn reports counts; a single tuple per side tells which one changed.
    const added: Tuple[] = [];
    const removed: Tuple[] = [];
    for (const t of remove) if ((await store.writeIn(tx, [], [t], actor, ctx.now)).removed > 0) removed.push(t);
    for (const t of add) if ((await store.writeIn(tx, [t], [], actor, ctx.now)).added > 0) added.push(t);
    return { added, removed };
  }
  const undo = memoryTx(tx);
  const out = store.writeNow(add, remove, actor);
  undo.onRollback(() => store.writeNow(out.removed, out.added, actor));
  return out;
}
