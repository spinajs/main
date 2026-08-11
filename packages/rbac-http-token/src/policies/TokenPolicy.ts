import { BasePolicy, IController, IRoute, ServerError, Request as sRequest } from '@spinajs/http';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { ACL_CONTROLLER_DESCRIPTOR, IRbacDescriptor, checkRoutePermission } from '@spinajs/rbac-http';
// Brings the `req.storage.TokenAuth` module augmentation into the program.
// Same side-effect import the middleware uses; without it this file compiles
// on its own against an un-augmented IActionLocalStoregeContext.
import '../interfaces.js';

/**
 * Route requires authentication with an access token AND the token's
 * effective roles must satisfy the route's @Resource/@Permission grants.
 *
 * Mirrors RbacPolicy's grant enforcement, but for token-authenticated
 * requests ( which carry no session ).
 *
 * WIRING - do NOT pass this policy to @Permission's `also` parameter:
 *
 *   @Permission(['readOwn'], TokenPolicy)   // BROKEN - always 401
 *
 * `@Permission` unconditionally bundles RbacPolicy together with every `also`
 * policy into the SAME policy group ( rbac-http/src/decorators.ts ), and
 * policies inside one group are combined with AND. RbacPolicy demands an
 * authorized session, which a token-authenticated request never has, so the
 * pair can never both pass and the route is permanently unreachable by token.
 *
 * Declare it as its OWN group at the ROUTE scope instead - groups of ONE scope
 * are ORed, so a token request satisfies the TokenPolicy group while a session
 * request satisfies the RbacPolicy group:
 *
 *   @Get('data')
 *   @Permission(['readOwn'])      // the permission metadata + RbacPolicy group
 *   @Policy(TokenPolicy)          // METHOD level - a second route scope group
 *
 * The placement is not free-standing: a CLASS level `@Policy(TokenPolicy)` goes
 * to the CONTROLLER scope, and the two scopes are ANDed - it would then have to
 * hold TOGETHER with the route's RbacPolicy group, which is exactly the broken
 * combination above. Only a method level declaration lands in the same scope as
 * `@Permission` and gets ORed with it.
 *
 * Writing `@Policy(TokenPolicy)` BELOW `@Permission` is deliberate too.
 * Decorators apply bottom up, so this one is pushed first, and when no group
 * holds `createPolicyGate` reports the first rejection in declaration order: a
 * token that authenticated but lacks the grant then gets this policy's 403
 * instead of RbacPolicy's misleading "user not logged" 401.
 *
 * The `@Permission` line is still required even with `@Policy(TokenPolicy)`:
 * this policy reads the same route permission metadata, and a route without it
 * silently inherits the controller-level default `['readOwn']` rather than
 * failing loudly.
 */
export class TokenPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: sRequest, action: IRoute, instance: IController): Promise<void> {
    if (!req.storage || !req.storage.TokenAuth || !req.storage.User) {
      throw new AuthenticationFailed('access token required');
    }

    const descriptor: IRbacDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, instance);

    // Guard BEFORE dereferencing `.Routes`: a route decorated with this policy
    // but no @Resource/@Permission must produce the descriptive server error,
    // not a raw TypeError 500.
    if (!descriptor || !descriptor.Permission || descriptor.Permission.length === 0) {
      throw new ServerError('no route permission or resources assigned');
    }

    let permission = descriptor.Permission ?? [];
    if (descriptor.Routes.has(String(action.Method))) {
      permission = descriptor.Routes.get(String(action.Method))!.Permission ?? [];
    }

    if (!permission.some((p) => checkRoutePermission(req, descriptor.Resource, p)?.granted)) {
      const effective = req.storage.ActiveRole ?? req.storage.User.Role;
      throw new Forbidden(`token role(s) ${effective} do not have permission ${permission} for resource ${descriptor.Resource}`);
    }
  }
}
