import { getInheritedDescriptor } from '@spinajs/di';
import { ACCESS_DESCRIPTOR } from '../api.js';
/** The key of a class-level `@Access` / `@AllowAnonymous` in `IAccessDescriptor` maps. */
export const ACCESS_CLASS = Symbol.for('authz:access:class');
const empty = () => ({ Access: new Map(), Anonymous: new Map(), Unscoped: new Map(), UnfilteredInput: new Map() });
/** The descriptor owned by the decorated class, for writing. */
export function ownAccessDescriptor(target) {
    const proto = target.prototype ?? target;
    return getInheritedDescriptor(proto, ACCESS_DESCRIPTOR, empty);
}
/** The nearest descriptor of a controller class or instance, for reading; undefined when nothing declared one. */
export function accessDescriptorOf(controller) {
    const proto = typeof controller === 'function' ? controller.prototype : controller;
    return Reflect.getMetadata(ACCESS_DESCRIPTOR, proto);
}
export function routeAccess(controller, method) {
    const d = accessDescriptorOf(controller);
    if (!d)
        return { anonymous: false };
    return {
        route: d.Access.get(method),
        controller: d.Access.get(ACCESS_CLASS),
        anonymous: d.Anonymous.has(method) || d.Anonymous.has(ACCESS_CLASS),
        unscoped: d.Unscoped.get(method),
        unfilteredInput: d.UnfilteredInput.get(method) ?? d.UnfilteredInput.get(ACCESS_CLASS),
    };
}
/** The authz domain a route checks in: its own `@Access`, else the class's, else root. */
export function routeDomain(access) {
    return access.route?.options.domain ?? access.controller?.options.domain ?? 'root';
}
//# sourceMappingURL=descriptor.js.map