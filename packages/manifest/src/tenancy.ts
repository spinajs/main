import type { AuthzSection, EntryTenancy, GlobalMiddlewareRef, TenancyDeclaration, TenancyEntryKind, TenancyEntryPoint, TenancySection } from './types.js';

/** The class the route decorators of `@spinajs/tenancy-http` mount, and the name of its `http.routes.middlewares` entry. */
export const TENANT_MIDDLEWARE = 'TenantMiddleware';

/** `carry` restores a scope only when the emitter had one, so it guarantees none. */
export const DECLARED_ENTRY_TENANCY: Readonly<Record<TenancyDeclaration, EntryTenancy>> = {
  TenantRoute: 'required',
  NoTenant: 'none',
  AllTenants: 'all',
  carry: 'none',
  required: 'required',
  none: 'none',
  each: 'each',
};

/** `http.routes.middlewares` holds `TenantMiddleware`, which then requires a tenant on every route that does not declare otherwise. */
export function mountsTenantMiddleware(globals: readonly GlobalMiddlewareRef[] | undefined): boolean {
  return (globals ?? []).some((m) => m.type === TENANT_MIDDLEWARE);
}

/** Nothing gives an entry point that declares nothing a scope, except the global mount on a route. */
export function undeclaredTenancy(kind: TenancyEntryKind, globalMount: boolean): EntryTenancy {
  return kind === 'route' && globalMount ? 'required' : 'none';
}

/** The entry points an authz section lists, as entry points that declare no tenancy. */
export function defaultEntryPoints(owner: { authz?: AuthzSection }): TenancyEntryPoint[] {
  return (owner.authz?.entryPoints ?? []).map((e) => ({ kind: e.kind, id: e.id, tenancy: undeclaredTenancy(e.kind, false), source: e.source }));
}

/** The tenancy of every entry point of a manifest: without a section none of them has a scope. */
export function entryTenancies(manifest: { authz?: AuthzSection; tenancy?: TenancySection }): TenancyEntryPoint[] {
  return manifest.tenancy?.entryPoints ?? defaultEntryPoints(manifest);
}
