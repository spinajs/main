import { Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AuthzAdminFailure, AuthzWriteHandler } from '../contracts/admin.js';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx } from '../contracts/admin.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Permission } from '../contracts/permission.js';
import type { Principal, ResourceRef } from '../contracts/principal.js';
import { GLOBAL, resourceKey } from '../contracts/resource.js';
import { AuthzService } from '../contracts/service.js';
import { AuthzClock } from '../host/clock.js';
import { adminActor, adminContainer } from './context.js';
import type { AdminCallContext } from './context.js';
import { ScopeForgetter, WritableScopeAttributeStore } from './ports.js';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const name = (v: unknown): string => (isObject(v) && typeof v.constructor === 'function' ? v.constructor.name : String(v));

function nodeOf(scope: unknown): ResourceRef {
  if (isObject(scope) && scope.type === GLOBAL.type) throw new AuthzAdminFailure('conflict', 'GLOBAL cannot be forgotten', 'scope');
  if (!isObject(scope) || typeof scope.type !== 'string' || scope.type === '' || typeof scope.id !== 'string' || scope.id === '') throw new AuthzAdminFailure('conflict', 'scope.forget needs one node: a resource ref with a type and an id', 'scope');
  return { type: scope.type, id: scope.id };
}

const scopeOf = (c: AuthzCommand): ResourceRef => nodeOf((c as { scope?: unknown }).scope);

/** Every ScopeForgetter, then the node's scope attributes, inside `tx`. */
async function forgetNode(container: IContainer, scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
  const where = `Authz domain ${JSON.stringify(ctx.domain)}`;
  let affected = 0;
  const tags = new Set<string>();
  const events: AuthzEvent[] = [];

  const forgetters = container.hasRegistered(ScopeForgetter) ? [...(await container.resolve(Array.chainOf(ScopeForgetter)))] : [];
  for (const f of forgetters) {
    if (!isObject(f) || typeof f.forget !== 'function') throw new AuthzConfigError(`${where}: ${name(f)} is not a ScopeForgetter`);
    const out: unknown = await f.forget(scope, ctx, tx);
    if (!isObject(out) || typeof out.affected !== 'number' || !Number.isInteger(out.affected) || out.affected < 0 || !Array.isArray(out.tags) || !out.tags.every((t) => typeof t === 'string') || !Array.isArray(out.events) || !out.events.every((e) => isObject(e) && typeof e.type === 'string' && isObject(e.data))) {
      throw new AuthzConfigError(`${where}: ${name(f)}.forget() must return { affected, tags: string[], events: { type, data }[] }`);
    }
    affected += out.affected;
    for (const t of out.tags as string[]) tags.add(t);
    events.push(...(out.events as AuthzEvent[]));
  }

  if (container.hasRegistered(WritableScopeAttributeStore)) {
    const store = (await container.resolve(WritableScopeAttributeStore)) as WritableScopeAttributeStore;
    affected += await store.forget(scope, tx);
  }

  // Always: decisions that read the node (attributes, ancestors) must not outlive it.
  tags.add(`scope:${resourceKey(scope)}`);
  const actor = adminActor(ctx);
  events.push({ type: 'ScopeForgotten', domain: ctx.domain, actor: { type: actor.type, id: actor.id }, at: ctx.now, data: { scope, affected } });
  return { affected, tags: [...tags], events };
}

/**
 * scope.forget: every model's data AT the node (each registered ScopeForgetter) and the node's scope
 * attributes, in the batch transaction. Data below the node is the caller's: it sends one command per node.
 */
@Singleton()
@Injectable(AuthzWriteHandler)
export class ScopeForgetHandler extends AuthzWriteHandler {
  readonly kinds = ['scope.forget'] as const;

  async validate(c: AuthzCommand): Promise<void> {
    scopeOf(c);
  }

  permission(c: AuthzCommand): { permission: Permission; resource: ResourceRef } {
    return { permission: 'authz:scope.forget', resource: scopeOf(c) };
  }

  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return forgetNode(adminContainer(ctx), scopeOf(c), ctx, tx);
  }
}

/**
 * Design §6.4 step 3: scope.forget's store writes for nodes a delete removed, in the caller's transaction,
 * since DbAuthzAdminBackend refuses to open one inside it. No permission check, guard, version bump, publish
 * or audit: the caller bumps the version, publishes the returned tags after its commit and audits as `ctx.actor`.
 */
export async function forgetScopesInTx(container: IContainer, scopes: readonly ResourceRef[], tx: AuthzTx, ctx: { readonly actor: Principal; readonly reason: string }): Promise<{ tags: string[] }> {
  if (!Array.isArray(scopes)) throw new AuthzConfigError('forgetScopesInTx needs an array of scopes');
  const nodes = scopes.map((scope) => {
    try {
      return nodeOf(scope);
    } catch (e) {
      throw new AuthzConfigError(`forgetScopesInTx: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  });
  if (nodes.length === 0) return { tags: [] };
  const service = (await container.resolve(AuthzService)) as AuthzService;
  const clock = (await container.resolve(AuthzClock)) as AuthzClock;
  const call: AdminCallContext = Object.freeze({ domain: service.domain, now: clock.now(), authz: service, reason: ctx.reason, actor: ctx.actor, container, dryRun: false });
  const tags = new Set<string>();
  for (const node of nodes) for (const t of (await forgetNode(container, node, call, tx)).tags) tags.add(t);
  return { tags: [...tags] };
}
