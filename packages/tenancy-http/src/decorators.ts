import { InvalidArgument } from '@spinajs/exceptions';
import { Middleware } from '@spinajs/http';
import { TenantMiddleware } from './middleware.js';
import type { TenantRouteDeclaration } from './middleware.js';

type RouteDecorator = ClassDecorator & MethodDecorator;

// A new object per use: TenantMiddleware.isEnabled tells a route's declaration from its controller's by identity.
const mount = (declaration: TenantRouteDeclaration): RouteDecorator => Middleware(TenantMiddleware, declaration) as RouteDecorator;

/** A tenant is required: the request is refused unless a resolver names a tenant it may enter. On a route or a controller; the route's wins. */
export function TenantRoute(): RouteDecorator {
  return mount({ tenancy: 'required' });
}

/** The route runs with no tenant scope (login, health, a tenant picker). */
export function NoTenant(): RouteDecorator {
  return mount({ tenancy: 'none' });
}

/** The route runs across all tenants; the reason is what the manifest records. */
export function AllTenants(reason: string): RouteDecorator {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text === '') {
    throw new InvalidArgument('@AllTenants needs a reason', 'reason');
  }
  return mount({ tenancy: 'all', reason: text });
}
