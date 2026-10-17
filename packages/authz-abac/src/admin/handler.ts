import { AuthzAdminFailure, AuthzConfigError, AuthzWriteHandler, GLOBAL, UnknownPermission, assertAdminPermission, memoryTx, principalKey } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx, Permission, Policy, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';
import { deepFreeze, isPlainObject } from '@spinajs/util';

import { InvalidPolicy } from '../model/policies.js';
import { AUTHZ_POLICY_COLUMNS, DbPolicyStore, policyTags } from '../model/stores/db.js';
import { abacModels, actorRef, byId, invalid, policiesInTx, policyChanged, quote, readId, sameScope, scopeOf, writableStore } from './common.js';
import type { WritablePolicyStore } from './common.js';

type PolicyInput = Omit<Policy, 'source'>;
type Applied = { id?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] };

const MANAGE: Permission = 'authz:policies.manage';

/** The shape a command must have before the model looks at it; returns a detached copy without undefined keys. */
function readPolicy(v: unknown, ctx: AdminContext): PolicyInput {
  if (!isPlainObject(v)) throw invalid('policy', 'policy must be an object');
  const id = readId(v.id, 'policy.id');
  if (id.length > AUTHZ_POLICY_COLUMNS.id) throw invalid('policy.id', `policy.id is longer than ${AUTHZ_POLICY_COLUMNS.id} characters`);
  if (v.effect !== 'permit' && v.effect !== 'deny') throw invalid('policy.effect', `policy.effect must be 'permit' or 'deny'`);
  if (!Array.isArray(v.permissions) || v.permissions.length === 0) throw invalid('policy.permissions', 'policy.permissions must be a non-empty list');
  if (v.source !== undefined) throw invalid('policy.source', 'policy.source is set by the store');
  const at = v.expiresAt;
  if (at !== undefined && at !== null) {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw invalid('policy.expiresAt', 'policy.expiresAt must be a valid Date or null');
    if (at.getTime() <= ctx.now.getTime()) throw invalid('policy.expiresAt', 'policy.expiresAt must lie after now; delete the policy instead');
  }
  const copy = structuredClone(v);
  for (const k of Object.keys(copy)) if (copy[k] === undefined) delete copy[k];
  return copy as unknown as PolicyInput;
}

/** The policy as stored: its scope in the form scopeOf gives, none for GLOBAL (as DbPolicyStore reads it back). */
function normalised(p: PolicyInput): PolicyInput {
  const { scope: _scope, ...rest } = p;
  const scope = scopeOf(p);
  return scope.type === GLOBAL.type ? rest : { ...rest, scope };
}

/** What the model would refuse at load: a stored policy it cannot load makes every reload of it fail. */
function validateWith(models: readonly { validate(p: PolicyInput, source: string): void }[], p: PolicyInput, source: string): void {
  for (const m of models) {
    try {
      m.validate(p, source);
    } catch (e) {
      if (!(e instanceof AuthzConfigError)) throw e;
      const field = e instanceof InvalidPolicy && e.field !== undefined ? `policy.${e.field}` : undefined;
      if (e instanceof UnknownPermission) throw new AuthzAdminFailure('unknown_permission', e.message, field ?? 'policy.permissions', { cause: e });
      if (field === 'policy.when') throw new AuthzAdminFailure('rule_not_compilable', e.message, field, { cause: e });
      throw new AuthzAdminFailure('invalid_command', e.message, field, { cause: e });
    }
  }
}

/** DbPolicyStore refuses these inside the transaction; refusing them here makes them a command error. */
function fitsColumns(p: PolicyInput, ctx: AdminContext): void {
  const texts: [string, string | undefined, number][] = [
    ['policy.reason', p.reason, AUTHZ_POLICY_COLUMNS.reason],
    ['policy.scope', p.scope?.type, AUTHZ_POLICY_COLUMNS.scope_type],
    ['policy.scope', p.scope?.id ?? undefined, AUTHZ_POLICY_COLUMNS.scope_id],
  ];
  for (const [field, v, max] of texts) if (typeof v === 'string' && v.length > max) throw invalid(field, `${field} is longer than ${max} characters (the authz_policy column)`);
  const actor = principalKey(actorRef(ctx));
  if (actor.length > AUTHZ_POLICY_COLUMNS.created_by) throw invalid(undefined, `the actor key ${quote(actor.slice(0, 40))}... is longer than the created_by column (${AUTHZ_POLICY_COLUMNS.created_by})`);
}

/**
 * policy.put (insert or replace by id) and policy.delete on the domain's writable PolicyStore. A put is
 * checked as every AbacModel of the domain would load it, so a stored policy can never break a reload.
 */
@Singleton()
@Injectable(AuthzWriteHandler)
export class AbacPolicyHandler extends AuthzWriteHandler {
  readonly kinds = ['policy.put', 'policy.delete'] as const;

  async validate(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    if (c.kind === 'policy.delete') {
      await this.row(c, ctx);
      return;
    }
    if (c.kind !== 'policy.put') throw new AuthzAdminFailure('not_found', `AbacPolicyHandler does not handle ${quote((c as AuthzCommand).kind)}`);
    const store = await writableStore(ctx);
    const p = readPolicy(c.policy, ctx);
    validateWith(abacModels(ctx), p, store.name);
    if (store instanceof DbPolicyStore) fitsColumns(p, ctx);
    // AuthzAdmin checks the new scope; a replace also takes the policy away from its old one.
    const existing = await byId(store, p.id);
    if (existing && !sameScope(existing, p)) await assertAdminPermission(ctx, 'policy.put', scopeOf(existing), MANAGE);
  }

  async permission(c: AuthzCommand, ctx: AdminContext): Promise<{ permission: Permission; resource: ResourceRef }> {
    if (c.kind === 'policy.put') return { permission: MANAGE, resource: scopeOf(readPolicy(c.policy, ctx)) };
    return { permission: MANAGE, resource: scopeOf(await this.row(c as Extract<AuthzCommand, { kind: 'policy.delete' }>, ctx)) };
  }

  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<Applied> {
    const store = await writableStore(ctx);
    if (c.kind === 'policy.put') return this.put(store, normalised(readPolicy(c.policy, ctx)), ctx, tx);
    return this.delete(store, readId((c as Extract<AuthzCommand, { kind: 'policy.delete' }>).id), ctx, tx);
  }

  private async put(store: WritablePolicyStore, p: PolicyInput, ctx: AdminContext, tx: AuthzTx): Promise<Applied> {
    const undo = store instanceof DbPolicyStore ? undefined : memoryTx(tx);
    // Phase A ran outside the transaction: another batch may have moved the policy since.
    const [before] = await policiesInTx(store, tx, { id: p.id });
    if (before && !sameScope(before, p)) await assertAdminPermission(ctx, 'policy.put', scopeOf(before), MANAGE);
    let tags: readonly string[];
    if (store instanceof DbPolicyStore) {
      ({ tags } = await store.put(p, actorRef(ctx), tx, ctx.now));
    } else {
      // Memory rows are shared with readers and the model, so a caller must not change one behind the store's version.
      store.put(deepFreeze({ ...p, source: store.name }));
      undo!.onRollback(() => (before ? store.put(before) : store.delete(p.id)));
      tags = policyTags(p.id);
    }
    return { id: p.id, affected: 1, tags, events: [policyChanged(ctx, p, 'put')] };
  }

  private async delete(store: WritablePolicyStore, id: string, ctx: AdminContext, tx: AuthzTx): Promise<Applied> {
    const undo = store instanceof DbPolicyStore ? undefined : memoryTx(tx);
    // An earlier command of the batch may have removed it since validate.
    const [before] = await policiesInTx(store, tx, { id });
    if (!before) return { id, affected: 0, tags: [], events: [] };
    // Checked again here: another batch may have moved the policy since permission() read its scope.
    await assertAdminPermission(ctx, 'policy.delete', scopeOf(before), MANAGE);
    let tags: readonly string[];
    if (store instanceof DbPolicyStore) {
      const out = await store.delete(id, tx);
      if (out.affected === 0) return { id, affected: 0, tags: [], events: [] };
      tags = out.tags;
    } else {
      store.delete(id);
      undo!.onRollback(() => store.put(before));
      tags = policyTags(id);
    }
    return { id, affected: 1, tags, events: [policyChanged(ctx, before, 'delete')] };
  }

  private async row(c: { readonly id: unknown }, ctx: AdminContext): Promise<Policy> {
    const id = readId(c.id);
    const row = await byId(await writableStore(ctx), id);
    if (!row) throw new AuthzAdminFailure('not_found', `no policy ${quote(id)} in the writable policy store`, 'id');
    return row;
  }
}
