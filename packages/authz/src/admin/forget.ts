import { Injectable, Singleton } from '@spinajs/di';

import { AuthzAdminFailure, AuthzWriteHandler } from '../contracts/admin.js';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx } from '../contracts/admin.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Permission } from '../contracts/permission.js';
import type { ResourceRef } from '../contracts/principal.js';
import { GLOBAL, resourceKey } from '../contracts/resource.js';
import { adminActor, adminContainer } from './context.js';
import { ScopeForgetter, WritableScopeAttributeStore } from './ports.js';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const name = (v: unknown): string => (isObject(v) && typeof v.constructor === 'function' ? v.constructor.name : String(v));

function scopeOf(c: AuthzCommand): ResourceRef {
  const scope: unknown = (c as { scope?: unknown }).scope;
  if (!isObject(scope) || typeof scope.type !== 'string' || scope.type === '' || typeof scope.id !== 'string' || scope.id === '') throw new AuthzAdminFailure('conflict', 'scope.forget needs one node: a resource ref with a type and an id', 'scope');
  if (scope.type === GLOBAL.type) throw new AuthzAdminFailure('conflict', 'GLOBAL cannot be forgotten', 'scope');
  return { type: scope.type, id: scope.id };
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
    const scope = scopeOf(c);
    const container = adminContainer(ctx);
    const where = `Authz domain ${JSON.stringify(ctx.domain)}`;
    let affected = 0;
    const tags = new Set<string>();
    const events: AuthzEvent[] = [];

    const forgetters = container.hasRegistered(ScopeForgetter) ? [...(await container.resolveChain(ScopeForgetter))] : [];
    for (const f of forgetters) {
      if (!isObject(f) || typeof f.forget !== 'function') throw new AuthzConfigError(`${where}: ${name(f)} is not a ScopeForgetter`);
      const out: unknown = await f.forget(scope, ctx, tx);
      if (!isObject(out) || typeof out.affected !== 'number' || !Number.isInteger(out.affected) || out.affected < 0 || !Array.isArray(out.tags) || !Array.isArray(out.events)) {
        throw new AuthzConfigError(`${where}: ${name(f)}.forget() must return { affected, tags, events }`);
      }
      affected += out.affected;
      for (const t of out.tags as unknown[]) if (typeof t === 'string') tags.add(t);
      events.push(...(out.events as AuthzEvent[]));
    }

    if (container.hasRegistered(WritableScopeAttributeStore)) {
      const store = (await container.resolve(WritableScopeAttributeStore)) as WritableScopeAttributeStore;
      const removed = await store.forget(scope, tx);
      affected += removed;
    }

    // Always: decisions that read the node (attributes, ancestors) must not outlive it.
    tags.add(`scope:${resourceKey(scope)}`);
    const actor = adminActor(ctx);
    events.push({ type: 'ScopeForgotten', domain: ctx.domain, actor: { type: actor.type, id: actor.id }, at: ctx.now, data: { scope, affected } });
    return { affected, tags: [...tags], events };
  }
}
