import { DI, Injectable } from '@spinajs/di';
import { AuthzConfigError } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { BaseController, CONTROLLED_DESCRIPTOR_SYMBOL, RouteType } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { routeAccess } from './descriptor.js';

/** `authz.http.unguardedRoutes`: what to do about a route with no `@Access`, `@Policy` or `@AllowAnonymous` on it or its class. */
export type UnguardedRoutesMode = 'warn' | 'throw' | 'off';

/** `Controller.method` of every http route of `controllers` that nothing guards. */
export function findUnguardedRoutes(controllers: Iterable<object>): string[] {
  const found: string[] = [];

  for (const type of new Set(controllers)) {
    const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, (type as { prototype: object }).prototype) as IControllerDescriptor | undefined;
    if (!descriptor) continue;

    for (const [method, route] of descriptor.Routes) {
      // A route decorator without a verb decorator is no route; http refuses it at registration.
      if (route.InternalType === RouteType.UNKNOWN) continue;
      const access = routeAccess(type, method);
      if (route.Policies.length > 0 || descriptor.Policies.length > 0 || access.route || access.controller || access.anonymous) continue;
      found.push(`${(type as { name: string }).name}.${String(method)}`);
    }
  }

  return found;
}

@Injectable()
export class UnguardedRoutesReport {
  @Logger('authz-http')
  protected Log: Log;

  @Config('authz.http.unguardedRoutes', { defaultValue: 'warn' })
  protected Mode: UnguardedRoutesMode;

  private readonly warned = new Set<string>();

  /** Checks `controllers` (the registered http controllers when omitted); returns the unguarded routes. */
  public run(controllers: Iterable<object> = DI.getRegisteredTypes(BaseController) ?? []): string[] {
    if (this.Mode === 'off') return [];

    const routes = findUnguardedRoutes(controllers);

    if (this.Mode === 'throw') {
      if (routes.length > 0) {
        throw new AuthzConfigError(`routes with no @Access, @Policy or @AllowAnonymous on them or their class (authz.http.unguardedRoutes is 'throw'): ${routes.join(', ')}`);
      }
      return routes;
    }

    for (const route of routes) {
      if (this.warned.has(route)) continue;
      this.warned.add(route);
      this.Log.warn({ route }, 'Route ${route} has no @Access, @Policy or @AllowAnonymous on it or its class');
    }

    return routes;
  }
}
