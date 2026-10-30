/**
 * Route path rules shared by the `@spinajs/http` router and the manifest compiler, so the
 * path a route is served at and the `fullPath` the manifest records cannot drift apart.
 *
 * Parts are joined as written: a leading slash in a route or base path yields `//`, which
 * Express does not collapse (`@Get('/x')` under `users` is served at `/users//x`).
 */
export function routeFullPath(basePath: string, path: string | undefined, handler: string): string {
  if (!path) return `/${basePath}/${handler}`;
  if (path === '/') return `/${basePath}`;
  if (basePath === '/') return `/${path}`;
  return `/${basePath}/${path}`;
}

/** The base a controller's routes are mounted under: `@BasePath` when set, else the lower-cased class name. */
export function controllerMountPath(basePath: string | null | undefined, className: string): string {
  return basePath ? basePath : className.toLowerCase();
}

/** A base path read from configuration (`@BasePath({ config, default })`) is used without its outer slashes. */
export function configuredMountPath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '') || '/';
}

/** Applies `http.controllers.route.prefix`; an empty prefix leaves the path unchanged. */
export function withRoutePrefix(prefix: string | undefined, path: string): string {
  return prefix ? `/${prefix}${path}` : path;
}
