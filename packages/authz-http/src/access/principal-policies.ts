import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { BasePolicy } from '@spinajs/http';
import type { IController, IPolicyDescriptor, IRoute, Request } from '@spinajs/http';

import { accessDescriptorOf } from './descriptor.js';
import { unauthenticated } from './policy.js';
import '../storage.js';

/** Passes for any principal, anonymous included; 401 when the request has none. */
export class HasPrincipal extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    if (!req.storage.Principal) throw unauthenticated('this route needs a principal');
  }
}

/**
 * Passes for an authenticated principal only; 401 otherwise. On a route with its own `@AllowAnonymous()`,
 * an `IsAuthenticated` the route inherits from its class passes for every request, with or without a principal.
 */
export class IsAuthenticated extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request, route?: IRoute, controller?: IController): Promise<void> {
    if (route && controller && this.liftedOn(route, controller)) return;
    if (!req.storage.Principal?.authenticated) throw unauthenticated('this route needs an authenticated principal');
  }

  // Passing rather than disabling keeps the policy's group in its scope: a disabled lone group would leave
  // the scope's alternative groups as the only way in, refusing callers the class admits on every other route.
  protected liftedOn(route: IRoute, controller: IController): boolean {
    if (!accessDescriptorOf(controller)?.Anonymous.has(route.Method)) return false;
    return !route.Policies.some((group) => group.some((p) => this.isSelf(p.Type)));
  }

  // http resolves a string descriptor as a configuration key holding the policy's type name.
  private isSelf(type: IPolicyDescriptor['Type']): boolean {
    return typeof type === 'string' ? DI.get(Configuration)?.get<string>(type) === this.constructor.name : type === this.constructor;
  }
}
