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
