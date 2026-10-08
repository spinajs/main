import { AuthzService, SYSTEM } from '@spinajs/authz';
import type { Decision, Permission, Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import type { Request } from '@spinajs/http';
import { userModel } from '@spinajs/users';
import type { User } from '@spinajs/users';

/** One user's metadata as a request reaches it. */
export interface MetadataScope {
  /** users.Id of the addressed user; the service limits every query to its rows. */
  readonly ownerId: number;

  /** Whether the caller may apply `permission` to `row`: a stored entry, or the entry a write would leave. */
  admits(permission: Permission, row: object): Promise<boolean>;
}

/**
 * The route's `@Access` decision and its principal. AccessPolicy leaves both for an allowed request; without them the
 * route was reached without its policy, and nothing is served.
 */
function routeDecision(req: Request): { principal: Principal; decision: Decision } {
  const principal = req.storage?.Principal;
  const decision = req.storage?.AuthzDecision;
  if (!principal || !decision || decision.allowed !== true) {
    throw new Forbidden('the metadata routes serve a request their @Access allowed');
  }

  return { principal, decision };
}

/**
 * The type-level decision of `@Access` holds for every row only when it is unconditional; a conditional one (users'
 * `user` role: `owner`) is decided again on each row, as the caller, with the row as subject.
 */
function scopeOf(principal: Principal, decision: Decision, ownerId: number): MetadataScope {
  const unconditional = decision.residual.op === 'true';

  return {
    ownerId,
    async admits(permission: Permission, row: object): Promise<boolean> {
      if (unconditional && permission === decision.permission) {
        return true;
      }

      const authz = (await DI.resolve(AuthzService)) as AuthzService;
      const onRow = await authz.check({ principal, permission, resource: { type: 'user.metadata' }, subject: row });
      return onRow.allowed === true;
    },
  };
}

/** `/user/metadata…`: the signed-in user's own metadata; the owner comes from the principal, never from the request. */
export function ownMetadata(req: Request, user: User): MetadataScope {
  const { principal, decision } = routeDecision(req);
  return scopeOf(principal, decision, user.Id);
}

/**
 * `/user/:user/metadata…`: the metadata of the user `uuid`. Another user's needs an unconditional grant: a conditional
 * one reaches only the caller's own uuid, and is refused before the lookup, so it cannot tell which accounts exist.
 */
export async function addressedMetadata(req: Request, uuid: string): Promise<MetadataScope> {
  const { principal, decision } = routeDecision(req);
  const own = principal.type === 'user' && principal.id === uuid;
  if (decision.residual.op !== 'true' && !own) {
    throw new Forbidden(`${decision.permission} on another user's metadata needs an unconditional grant`);
  }

  const authz = (await DI.resolve(AuthzService)) as AuthzService;
  // As SYSTEM: the application's user model may be scoped, and the addressed user is looked up for an allowed caller.
  const user = (await authz.runAs(SYSTEM, 'user-metadata-owner', () => userModel().query().where('Uuid', uuid).first())) as User | undefined;
  if (!user || user.DeletedAt) {
    throw new ResourceNotFound('User not found');
  }

  return scopeOf(principal, decision, user.Id);
}
