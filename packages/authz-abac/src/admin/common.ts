import { AuthzAdminFailure, AuthzConfigError, GLOBAL, adminActor, adminContainer } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, Policy, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { OrmDriver } from '@spinajs/orm';

import { PolicyStore } from '../contracts.js';
import { AbacModel } from '../model/model.js';
import { AUTHZ_POLICY_TABLE, DbPolicyStore, rowToPolicy } from '../model/stores/db.js';
import { MemoryPolicyStore } from '../model/stores/memory.js';

export type WritablePolicyStore = MemoryPolicyStore | DbPolicyStore;

export const quote = (v: unknown): string => JSON.stringify(v) ?? String(v);

export const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A command field of the wrong shape; the codes list of the contract has none for it. */
export const invalid = (field: string | undefined, message: string): AuthzAdminFailure => new AuthzAdminFailure('invalid_command', message, field);

export function readId(v: unknown, field = 'id'): string {
  if (typeof v !== 'string' || v === '') throw invalid(field, `${field} must be a non-empty string`);
  return v;
}

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
  const stores = container.hasRegistered(PolicyStore) ? [...(await container.resolveChain(PolicyStore))] : [];
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

/** The ORM driver of a DB transaction, as DbPolicyStore requires it for writes. */
function ormDriver(tx: AuthzTx): OrmDriver {
  const driver = tx?.driver;
  if (!(driver instanceof OrmDriver)) throw new AuthzConfigError('DbPolicyStore: AuthzTx.driver must be the OrmDriver of an AuthzAdmin transaction');
  return driver;
}

/**
 * Policies as the transaction sees them, so the batch's own earlier writes count. A DB store's load() may
 * run on another connection, which does not see them before the commit.
 */
export async function policiesInTx(store: WritablePolicyStore, tx: AuthzTx, where: { readonly id?: string; readonly scope?: ResourceRef } = {}): Promise<Policy[]> {
  if (store instanceof MemoryPolicyStore) {
    return (await store.load()).filter((p) => (where.id === undefined || p.id === where.id) && (where.scope === undefined || sameScope(p, { scope: where.scope })));
  }
  let query = ormDriver(tx).select().from(AUTHZ_POLICY_TABLE);
  if (where.id !== undefined) query = query.where('id', where.id);
  if (where.scope !== undefined) {
    const s = scopeOf({ scope: where.scope });
    query = query.where('scope_type', s.type).where('scope_id', s.id ?? '');
  }
  return ((await query) as unknown as Parameters<typeof rowToPolicy>[0][]).map(rowToPolicy);
}

export function actorRef(ctx: AdminContext): PrincipalRef {
  const a = adminActor(ctx);
  return { type: a.type, id: a.id };
}

export function policyChanged(ctx: AdminContext, p: { readonly id: string; readonly scope?: ResourceRef }, op: 'put' | 'delete'): AuthzEvent {
  return { type: 'PolicyChanged', domain: ctx.domain, actor: actorRef(ctx), at: ctx.now, data: { id: p.id, ...(p.scope ? { scope: { ...p.scope } } : {}), op } };
}
