import type { Permission } from '@spinajs/authz';
import type { AccessOptions } from '../api.js';
/** The key of a class-level `@Access` / `@AllowAnonymous` in `IAccessDescriptor` maps. */
export declare const ACCESS_CLASS: unique symbol;
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
/** The descriptor owned by the decorated class, for writing. */
export declare function ownAccessDescriptor(target: object): IAccessDescriptor;
/** The nearest descriptor of a controller class or instance, for reading; undefined when nothing declared one. */
export declare function accessDescriptorOf(controller: object): IAccessDescriptor | undefined;
export interface RouteAccess {
    readonly route?: IAccessRule;
    readonly controller?: IAccessRule;
    /** `@AllowAnonymous` on the route or the class. */
    readonly anonymous: boolean;
    readonly unscoped?: string;
    /** `@UnfilteredInput(reason)` on the route or the class. */
    readonly unfilteredInput?: string;
}
export declare function routeAccess(controller: object, method: AccessKey): RouteAccess;
/** The authz domain a route checks in: its own `@Access`, else the class's, else root. */
export declare function routeDomain(access: RouteAccess): string;
//# sourceMappingURL=descriptor.d.ts.map