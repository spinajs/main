import { AuthzConfigError, GLOBAL, adminActor, adminContainer } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, Policy, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { deepFreeze as freeze, isPlainObject } from '@spinajs/util';

import { PolicyStore } from '../contracts.js';
import { AbacModel } from '../model/model.js';
import { DbPolicyStore, hydrateRecords, recordToPolicy } from '../model/stores/db.js';
import { MemoryPolicyStore } from '../model/stores/memory.js';
import { PolicyRecord, requirePolicyTransaction } from '../model/stores/policy-record.js';

export type WritablePolicyStore = MemoryPolicyStore | DbPolicyStore;

export const quote = (v: unknown): string => JSON.stringify(v) ?? String(v);

export { isPlainObject };

/**
 * The one writable PolicyStore registered in the domain (a MemoryPolicyStore or a DbPolicyStore); config
 * stores are skipped. None: AuthzConfigError, or undefined when not `required`. Two: AuthzConfigError,
 * since a command could not tell which one the AbacModel reads the policy from.
 */
export async function writableStore(ctx: AdminContext): Promise<WritablePolicyStore>;
export async function writableStore(ctx: AdminContext, required: false): Promise<WritablePolicyStore | undefined>;
export async function writableStore(ctx: AdminContext, required = true): Promise<WritablePolicyStore | undefined> {
  const container = adminContainer(ctx);
  const where = `Authz domain ${quote(ctx.domain)}`;
  const stores = container.hasRegistered(PolicyStore) ? [...(await container.resolve(Array.chainOf(PolicyStore)))] : [];
  const writable = [...new Set(stores.filter((s): s is WritablePolicyStore => s instanceof MemoryPolicyStore || s instanceof DbPolicyStore))];
  if (writable.length > 1) throw new AuthzConfigError(`${where}: more than one writable PolicyStore is registered (${writable.map((s) => s.constructor.name).join(', ')}); register only the one the AbacModel writes to`);
  if (writable.length === 0 && required) throw new AuthzConfigError(`${where}: no MemoryPolicyStore or DbPolicyStore is registered as PolicyStore; the ABAC policy commands of AuthzAdmin write to the one the domain's AbacModel reads`);
  return writable[0];
}

export function abacModels(ctx: AdminContext): AbacModel[] {
  const models = ctx.authz.models().filter((m): m is AbacModel => m instanceof AbacModel);
  if (models.length === 0) throw new AuthzConfigError(`Authz domain ${quote(ctx.domain)} has no AbacModel to check a policy against`);
  return models;
}

/** Where a policy applies: its scope, GLOBAL when it has none. */
export function scopeOf(p: { readonly scope?: ResourceRef }): ResourceRef {
  const s = p.scope;
  return !s || s.type === GLOBAL.type ? GLOBAL : s.id === undefined || s.id === null ? { type: s.type } : { type: s.type, id: s.id };
}

export function sameScope(a: { readonly scope?: ResourceRef }, b: { readonly scope?: ResourceRef }): boolean {
  const x = scopeOf(a);
  const y = scopeOf(b);
  return x.type === y.type && (x.id ?? undefined) === (y.id ?? undefined);
}

export async function byId(store: WritablePolicyStore, id: string): Promise<Policy | undefined> {
  return (await store.load()).find((p) => p.id === id);
}

/** Policies as the batch's transaction sees them, so its own earlier writes count. */
export async function policiesInTx(store: WritablePolicyStore, tx: AuthzTx, where: { readonly id?: string; readonly scope?: ResourceRef } = {}): Promise<Policy[]> {
  if (store instanceof MemoryPolicyStore) {
    return (await store.load()).filter((p) => (where.id === undefined || p.id === where.id) && (where.scope === undefined || sameScope(p, { scope: where.scope })));
  }
  requirePolicyTransaction(tx, 'policiesInTx');
  const query = PolicyRecord.query();
  if (where.id !== undefined) query.where('id', where.id);
  if (where.scope !== undefined) {
    const s = scopeOf({ scope: where.scope });
    query.where('scope_type', s.type).where('scope_id', s.id ?? '');
  }
  return (await hydrateRecords(query)).map(recordToPolicy);
}

export function actorRef(ctx: AdminContext): PrincipalRef {
  const a = adminActor(ctx);
  return { type: a.type, id: a.id };
}

/** `scope` in the form scopeOf gives, left out for GLOBAL. */
export function policyChanged(ctx: AdminContext, p: { readonly id: string; readonly scope?: ResourceRef }, op: 'put' | 'delete'): AuthzEvent {
  const scope = scopeOf(p);
  return { type: 'PolicyChanged', domain: ctx.domain, actor: actorRef(ctx), at: ctx.now, data: { id: p.id, ...(scope.type === GLOBAL.type ? {} : { scope }), op } };
}

/** Stored memory rows are shared with readers and the model; freezing them keeps a caller from changing the store behind its version. */
export const deepFreeze = <T>(v: T): Readonly<T> => freeze(v, { skipDates: true });
