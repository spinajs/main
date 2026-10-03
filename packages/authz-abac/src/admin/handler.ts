import { AuthzAdminFailure, AuthzConfigError, AuthzWriteHandler, UnknownPermission, assertAdminPermission, memoryTx, principalKey } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx, Permission, Policy, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { DbPolicyStore, policyTags } from '../model/stores/db.js';
import { abacModels, actorRef, byId, invalid, isPlainObject, policiesInTx, policyChanged, quote, readId, sameScope, scopeOf, writableStore } from './common.js';
import type { WritablePolicyStore } from './common.js';

type PolicyInput = Omit<Policy, 'source'>;
type Applied = { id?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] };

const MANAGE: Permission = 'authz:policies.manage';
const POLICY_KEYS = new Set(['id', 'effect', 'permissions', 'resourceTypes', 'principalTypes', 'actorTypes', 'scope', 'when', 'fields', 'reason', 'priority', 'expiresAt']);
// The authz_policy column widths DbPolicyStore enforces (design §9.1), and created_by.
const MAX_ID = 64;
const MAX_TEXT = 64;
const MAX_ACTOR = 100;

/** The shape a command must have before the model looks at it; returns a detached copy without undefined keys. */
function readPolicy(v: unknown, ctx: AdminContext): PolicyInput {
  if (!isPlainObject(v)) throw invalid('policy', 'policy must be an object');
  const id = readId(v.id, 'policy.id');
  if (id.length > MAX_ID) throw invalid('policy.id', `policy.id is longer than ${MAX_ID} characters`);
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

/** The command field an AbacModel error names (its messages read `abac policy "<id>"[ when]: <text>`). */
function fieldOf(message: string, id: string): string | undefined {
  const head = `abac policy ${JSON.stringify(id)}`;
  if (!message.startsWith(head)) return undefined;
  const rest = message.slice(head.length);
  if (rest.startsWith(' when')) return 'policy.when';
  const text = rest.replace(/^: /, '');
  const unknownKey = /^unknown key "([^"]+)"/.exec(text);
  if (unknownKey) return `policy.${unknownKey[1]}`;
  if (/permission/.test(text)) return 'policy.permissions';
  if (/^the id /.test(text)) return 'policy.id';
  if (/^a \$global scope/.test(text)) return 'policy.scope';
  const key = /^(\w+)/.exec(text)?.[1];
  return key !== undefined && POLICY_KEYS.has(key) ? `policy.${key}` : undefined;
}

/** What the model would refuse at load: a stored policy it cannot load makes every reload of it fail. */
function validateWith(models: readonly { validate(p: PolicyInput, source: string): void }[], p: PolicyInput, source: string): void {
  for (const m of models) {
    try {
      m.validate(p, source);
    } catch (e) {
      if (!(e instanceof AuthzConfigError)) throw e;
      const field = fieldOf(e.message, p.id);
      if (e instanceof UnknownPermission) throw new AuthzAdminFailure('unknown_permission', e.message, field ?? 'policy.permissions', { cause: e });
      if (field === 'policy.when') throw new AuthzAdminFailure('rule_not_compilable', e.message, field, { cause: e });
      throw new AuthzAdminFailure('invalid_command', e.message, field, { cause: e });
    }
  }
}

/** DbPolicyStore refuses these inside the transaction; refusing them here makes them a command error. */
function fitsColumns(p: PolicyInput, ctx: AdminContext): void {
  const texts: [string, string | undefined][] = [
    ['policy.reason', p.reason],
    ['policy.scope', p.scope?.type],
    ['policy.scope', p.scope?.id ?? undefined],
  ];
  for (const [field, v] of texts) if (typeof v === 'string' && v.length > MAX_TEXT) throw invalid(field, `${field} is longer than ${MAX_TEXT} characters (the authz_policy column)`);
  const actor = principalKey(actorRef(ctx));
  if (actor.length > MAX_ACTOR) throw invalid(undefined, `the actor key ${quote(actor.slice(0, 40))}... is longer than the created_by column (${MAX_ACTOR})`);
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
    if (c.kind === 'policy.put') return this.put(store, readPolicy(c.policy, ctx), ctx, tx);
    return this.delete(store, readId((c as Extract<AuthzCommand, { kind: 'policy.delete' }>).id), ctx, tx);
  }

  private async put(store: WritablePolicyStore, p: PolicyInput, ctx: AdminContext, tx: AuthzTx): Promise<Applied> {
    let tags: readonly string[];
    if (store instanceof DbPolicyStore) {
      ({ tags } = await store.put(p, actorRef(ctx), tx, ctx.now));
    } else {
      const undo = memoryTx(tx);
      const before = await byId(store, p.id);
      store.put({ ...p, source: store.name });
      undo.onRollback(() => (before ? store.put(before) : store.delete(p.id)));
      tags = policyTags(p.id);
    }
    return { id: p.id, affected: 1, tags, events: [policyChanged(ctx, p, 'put')] };
  }

  private async delete(store: WritablePolicyStore, id: string, ctx: AdminContext, tx: AuthzTx): Promise<Applied> {
    const undo = store instanceof DbPolicyStore ? undefined : memoryTx(tx);
    // An earlier command of the batch may have removed it since validate.
    const [before] = await policiesInTx(store, tx, { id });
    if (!before) return { id, affected: 0, tags: [], events: [] };
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
