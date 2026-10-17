import type { IContainer } from '@spinajs/di';

import type { AdminContext } from '../contracts/admin.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Principal } from '../contracts/principal.js';
import { isObject } from '../engine/internal/util.js';

/**
 * What DefaultAuthzAdmin passes as AdminContext; handlers, guards and validators may read the extra fields.
 * The frozen AdminContext has neither the actor nor the domain container, which handlers need.
 */
export interface AdminCallContext extends AdminContext {
  readonly actor: Principal;
  /** The domain container; resolve stores from it. */
  readonly container: IContainer;
  readonly dryRun: boolean;
}

function callContext(ctx: AdminContext, what: string): AdminCallContext {
  const c = ctx as unknown as Record<string, unknown> | undefined;
  const actor = c?.actor;
  const container = c?.container;
  if (!isObject(actor) || typeof actor.type !== 'string' || typeof actor.id !== 'string' || !isObject(container) || typeof container.resolve !== 'function') {
    throw new AuthzConfigError(`${what} needs the AdminCallContext AuthzAdmin passes; this context has no actor or container`);
  }
  return ctx as AdminCallContext;
}

export function adminActor(ctx: AdminContext): Principal {
  return callContext(ctx, 'adminActor').actor;
}

export function adminContainer(ctx: AdminContext): IContainer {
  return callContext(ctx, 'adminContainer').container;
}
