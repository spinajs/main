import type { ControllerEntry, RouteEntry } from '@spinajs/manifest';
import type { OpenAPIV3_1 } from 'openapi-types';

export function isAnonymous(route: RouteEntry, controller: ControllerEntry): boolean {
  return (route.allowAnonymous ?? (route.access === undefined ? controller.allowAnonymous : false)) === true;
}

export function permissionsOf(route: RouteEntry, controller: ControllerEntry): string[] {
  return route.access ?? controller.access ?? [];
}

/** Same vendor extensions `@spinajs/authz-http` writes through swaggerAccess(), so snapshots stay comparable. */
export function applyAccess(operation: OpenAPIV3_1.OperationObject, route: RouteEntry, controller: ControllerEntry): void {
  const op = operation as Record<string, unknown>;
  if (isAnonymous(route, controller)) {
    op['x-authz-anonymous'] = true;
    operation.security = [];
    return;
  }
  const permissions = permissionsOf(route, controller);
  if (permissions.length === 0) return;
  op['x-authz-permission'] = [...permissions];
  const first = permissions[0];
  const colon = first.indexOf(':');
  op['x-authz-resource'] = { type: colon < 0 ? first : first.slice(0, colon) };
}
