import { parsePermission } from '@spinajs/authz';
import type { Permission, ResourceType } from '@spinajs/authz';

import { routeAccess } from './access/descriptor.js';
import type { AccessKey, IAccessRule } from './access/descriptor.js';
import { extractorInfo } from './access/extractors.js';

/** Where an operation finds its resource, for `x-authz-resource`. */
export interface SwaggerAccessResource {
  /** Absent for `fromModel`, whose type the ORM adapter knows. */
  readonly type?: ResourceType;
  readonly in?: 'path' | 'body' | 'query';
  readonly name?: string;
  readonly by?: string;
  readonly model?: string;
}

/** The OpenAPI vendor extensions of one operation (design §11.5: they replace `x-rbac-*`). */
export interface SwaggerAccess {
  /** Any of these (the route's own @Access, else the class's). */
  readonly 'x-authz-permission': readonly Permission[];
  /** A class-level @Access the route's own one narrows (both must pass). */
  readonly 'x-authz-controller-permission'?: readonly Permission[];
  readonly 'x-authz-resource': SwaggerAccessResource;
  readonly 'x-authz-domain'?: string;
  readonly 'x-authz-anonymous'?: true;
  readonly 'x-authz-unscoped'?: string;
  /** `@UnfilteredInput(reason)`: the body is not field-filtered. */
  readonly 'x-authz-unfiltered-input'?: string;
}

const IN = { param: 'path', body: 'body', query: 'query' } as const;

function resourceOf(rule: IAccessRule): SwaggerAccessResource {
  const info = extractorInfo(rule.options.resource);
  if (!rule.options.resource) return { type: parsePermission(rule.permissions[0]).resource };
  if (!info) return {};
  if (info.from === 'model') return { in: 'path', name: info.name, model: info.model?.name };
  return { ...(info.type !== undefined ? { type: info.type } : {}), ...(info.from ? { in: IN[info.from] } : {}), ...(info.name !== undefined ? { name: info.name } : {}), ...(info.by !== undefined ? { by: info.by } : {}) };
}

/**
 * What `@Access`, `@AllowAnonymous` and `@Unscoped` declare for one route, as OpenAPI vendor
 * extensions read from `ACCESS_DESCRIPTOR`; undefined for a route no `@Access` guards. For
 * http-swagger (plan C7).
 */
export function swaggerAccess(controller: object, method: AccessKey): SwaggerAccess | undefined {
  const access = routeAccess(controller, method);
  const rule = access.route ?? access.controller;
  if (!rule) return undefined;

  const domain = rule.options.domain;
  return {
    'x-authz-permission': [...rule.permissions],
    ...(access.route && access.controller ? { 'x-authz-controller-permission': [...access.controller.permissions] } : {}),
    'x-authz-resource': resourceOf(rule),
    ...(domain !== undefined && domain !== 'root' ? { 'x-authz-domain': domain } : {}),
    ...(access.anonymous ? { 'x-authz-anonymous': true as const } : {}),
    ...(access.unscoped !== undefined ? { 'x-authz-unscoped': access.unscoped } : {}),
    ...(access.unfilteredInput !== undefined ? { 'x-authz-unfiltered-input': access.unfilteredInput } : {}),
  };
}
