var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { NewInstance } from '@spinajs/di';
import { AuthzConfigError, parsePermission } from '@spinajs/authz';
import { Middleware, Route, RouteMiddleware } from '@spinajs/http';
import { auditUnscoped } from '../domains.js';
import { ACCESS_CLASS, ownAccessDescriptor, routeAccess, routeDomain } from './descriptor.js';
import { AccessPolicy } from './policy.js';
import { AuthzFieldsMiddleware } from '../fields.js';
import '../storage.js';
// Keys each class declared itself, to tell a second @Access on one member from an override of an inherited one.
const declared = new WeakMap();
function declareOnce(target, key) {
    const proto = target.prototype ?? target;
    const keys = declared.get(proto) ?? new Set();
    if (keys.has(key)) {
        const owner = proto.constructor.name;
        throw new AuthzConfigError(`@Access is declared twice on ${owner}${key === ACCESS_CLASS ? '' : `.${String(key)}`}`);
    }
    declared.set(proto, keys.add(key));
}
/**
 * Guards a route, or every route of a controller, with authorization (design §11.2). One policy
 * group: `AccessPolicy` AND the `also` policies (B23); other `@Policy` groups at the same place
 * stay alternatives (OR), and a class-level `@Access` narrows every route (http combines the
 * class and route scopes with AND). On a subclass it
 * replaces the inherited `@Access` group of that place instead of adding an alternative to it.
 */
export function Access(permission, opts) {
    const permissions = typeof permission === 'string' ? [permission] : [...permission];
    if (permissions.length === 0) {
        throw new AuthzConfigError('@Access needs at least one permission');
    }
    // A malformed name fails when the controller module loads, not on the first request.
    permissions.forEach((p) => parsePermission(p));
    const rule = { permissions: Object.freeze(permissions), options: Object.freeze({ ...(opts ?? {}) }) };
    return Route((controller, route, target, propertyKey) => {
        const key = propertyKey ?? ACCESS_CLASS;
        declareOnce(target, key);
        ownAccessDescriptor(target).Access.set(key, rule);
        const groups = route ? route.Policies : controller.Policies;
        const inherited = groups.findIndex((g) => g[0]?.Type === AccessPolicy);
        if (inherited >= 0) {
            groups.splice(inherited, 1);
        }
        // The policy reads the rule from the descriptor at request time, so swagger, the boot refs and the check agree.
        const group = [{ Type: AccessPolicy, Options: [route ? 'route' : 'class'] }, ...(rule.options.also ?? []).map((Type) => ({ Type: Type, Options: [] }))];
        groups.push(group);
        const middlewares = route ? route.Middlewares : controller.Middlewares;
        if (rule.options.fields === 'filter' && !middlewares.some((m) => m.Type === AuthzFieldsMiddleware)) {
            middlewares.push({ Type: AuthzFieldsMiddleware, Options: [] });
        }
    });
}
/** Lets an unauthenticated principal (anonymous) pass the authentication part of `@Access`; without a principal the route still answers 401. */
export function AllowAnonymous() {
    return ((target, propertyKey) => {
        ownAccessDescriptor(target).Anonymous.set(propertyKey ?? ACCESS_CLASS, true);
    });
}
/**
 * Leaves the route's body input as the caller sent it: no `fields.write` and no `fields.neverRead`
 * filter. For routes whose body legitimately carries such fields, e.g. an admin creating a user
 * with a password; the reason documents why.
 */
export function UnfilteredInput(reason) {
    if (typeof reason !== 'string' || reason.trim() === '') {
        throw new AuthzConfigError('@UnfilteredInput needs a reason');
    }
    return ((target, propertyKey) => {
        ownAccessDescriptor(target).UnfilteredInput.set(propertyKey ?? ACCESS_CLASS, reason);
    });
}
/**
 * Sets `req.storage.Unscoped` for the action, so the ORM applies no residual to the route's
 * queries, and audits the bypass (kind `unscoped`) in the route's domain (B09). Runs after the
 * policies: a refused request is no bypass.
 */
let UnscopedMiddleware = class UnscopedMiddleware extends RouteMiddleware {
    constructor(reason) {
        super();
        this.reason = reason;
    }
    /** Called when http registers the route: an unguarded route must not run unscoped, so registration fails. */
    isEnabled(route, controller) {
        const access = routeAccess(controller, route.Method);
        if (!access.route && !access.controller) {
            throw new AuthzConfigError(`@Unscoped on ${controller.constructor.name}.${String(route.Method)} needs an @Access on the route or its class`);
        }
        return true;
    }
    async onBefore(req, _res, route, controller) {
        const r = req;
        r.storage.Unscoped = this.reason;
        const principal = r.storage.Principal;
        await auditUnscoped(routeDomain(routeAccess(controller, route.Method)), {
            kind: 'unscoped',
            principal: principal ? { type: principal.type, id: principal.id } : { type: 'unattended', id: 'unattended' },
            reason: this.reason,
        });
    }
    async onResponse(_response) { }
    async onAfter() { }
};
UnscopedMiddleware = __decorate([
    NewInstance(),
    __metadata("design:paramtypes", [String])
], UnscopedMiddleware);
export { UnscopedMiddleware };
export function Unscoped(reason) {
    if (typeof reason !== 'string' || reason.trim() === '') {
        throw new AuthzConfigError('@Unscoped needs a reason');
    }
    const middleware = Middleware(UnscopedMiddleware, reason);
    return ((target, propertyKey, descriptor) => {
        ownAccessDescriptor(target).Unscoped.set(propertyKey, reason);
        middleware(target, propertyKey, descriptor);
    });
}
//# sourceMappingURL=decorators.js.map