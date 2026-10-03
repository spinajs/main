import { getInheritedDescriptor } from '@spinajs/di';
import type { Permission } from '@spinajs/authz';

import { ACCESS_DESCRIPTOR } from '../api.js';
import type { AccessOptions } from '../api.js';

/** The key of a class-level `@Access` / `@AllowAnonymous` in `IAccessDescriptor` maps. */
export const ACCESS_CLASS: unique symbol = Symbol.for('authz:access:class');

export type AccessKey = string | symbol;

export interface IAccessRule {
  readonly permissions: readonly Permission[];
  readonly options: Readonly<AccessOptions>;
}

/**
 * What `@Access`, `@AllowAnonymous` and `@Unscoped` declared on a controller, under
 * `ACCESS_DESCRIPTOR` on its prototype. Keys are route method names, or `ACCESS_CLASS` for the
 * class. A subclass owns a copy that starts with what it inherits.
 */
export interface IAccessDescriptor {
  Access: Map<AccessKey, IAccessRule>;
  Anonymous: Map<AccessKey, true>;
  Unscoped: Map<AccessKey, string>;
  UnfilteredInput: Map<AccessKey, string>;
}

const empty = (): IAccessDescriptor => ({ Access: new Map(), Anonymous: new Map(), Unscoped: new Map(), UnfilteredInput: new Map() });

/** The descriptor owned by the decorated class, for writing. */
export function ownAccessDescriptor(target: object): IAccessDescriptor {
  const proto = (target as { prototype?: object }).prototype ?? target;
  return getInheritedDescriptor<IAccessDescriptor>(proto, ACCESS_DESCRIPTOR, empty);
}

/** The nearest descriptor of a controller class or instance, for reading; undefined when nothing declared one. */
export function accessDescriptorOf(controller: object): IAccessDescriptor | undefined {
  const proto = typeof controller === 'function' ? (controller as { prototype: object }).prototype : controller;
  return Reflect.getMetadata(ACCESS_DESCRIPTOR, proto) as IAccessDescriptor | undefined;
}

export interface RouteAccess {
  readonly route?: IAccessRule;
  readonly controller?: IAccessRule;
  /** `@AllowAnonymous` on the route or the class. */
  readonly anonymous: boolean;
  readonly unscoped?: string;
  /** `@UnfilteredInput(reason)` on the route or the class. */
  readonly unfilteredInput?: string;
}

export function routeAccess(controller: object, method: AccessKey): RouteAccess {
  const d = accessDescriptorOf(controller);
  if (!d) return { anonymous: false };
  return {
    route: d.Access.get(method),
    controller: d.Access.get(ACCESS_CLASS),
    anonymous: d.Anonymous.has(method) || d.Anonymous.has(ACCESS_CLASS),
    unscoped: d.Unscoped.get(method),
    unfilteredInput: d.UnfilteredInput.get(method) ?? d.UnfilteredInput.get(ACCESS_CLASS),
  };
}

/** The authz domain a route checks in: its own `@Access`, else the class's, else root. */
export function routeDomain(access: RouteAccess): string {
  return access.route?.options.domain ?? access.controller?.options.domain ?? 'root';
}
