var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { DI, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AccessDenied, AuthzConfigError, AuthzDomains, FALSE, ResourceAdapter, Unauthenticated, authzStorage, isProduction, parsePermission, DefaultAuthzDomains } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import { domainConfig } from '../domains.js';
import { routeAccess, routeDomain } from './descriptor.js';
import { isUnloadedModel } from './extractors.js';
import '../storage.js';
/** 401 body: `{ error: 'unauthenticated', message }`. */
export function unauthenticated(message) {
    return Object.assign(new Unauthenticated(message), { error: 'unauthenticated' });
}
/** The reason as the 403 body shows it: its payload without the ordering keys (design §11.2). */
export function publicReason(reason) {
    if (!reason)
        return undefined;
    const { priority: _priority, sortKey: _sortKey, ...rest } = reason;
    return rest;
}
/** AccessDenied whose enumerable props are the 403 body `{ error, permission, resource, reason, trace? }`; http spreads them into the response. */
export function forbidden(decision, trace) {
    const body = { error: 'forbidden', permission: decision.permission, resource: decision.resource };
    const reason = publicReason(decision.reason);
    if (reason)
        body.reason = reason;
    if (trace !== undefined)
        body.trace = trace;
    return Object.assign(new AccessDenied(decision), body);
}
/** The check of the explain permission; only an unconditional grant holds it, since nothing on the explain paths would enforce a residual. */
export async function holdsExplain(authz, principal, permission) {
    const decision = await authz.check({ principal, permission, resource: { type: parsePermission(permission).resource } });
    return { held: decision.allowed && decision.residual.op === 'true', decision };
}
const isRef = (v) => typeof v === 'object' && v !== null && typeof v.type === 'string' && Object.keys(v).every((k) => k === 'type' || k === 'id');
/**
 * Decides the `@Access` of its scope (design §11.2), read from the controller's descriptor at
 * request time: a request without a principal, or with an unauthenticated one on a route without
 * `@AllowAnonymous`, is refused 401; several permissions mean any of them; a denial throws a 403
 * with `{ error, permission, resource, reason }`. With `subject: 'load'` a conditional allow is
 * settled against the row the domain's adapter loads. The allowing decision of the route's own
 * `@Access` (else the class's) goes to `req.storage.AuthzDecision`.
 */
let AccessPolicy = class AccessPolicy extends BasePolicy {
    constructor(scope) {
        super();
        this.scope = scope;
    }
    isEnabled() {
        return true;
    }
    async execute(req, route, controller) {
        const access = routeAccess(controller, route.Method);
        const rule = this.scope === 'route' ? access.route : access.controller;
        if (!rule) {
            throw new AuthzConfigError(`AccessPolicy on ${controller.constructor.name}.${String(route.Method)} finds no ${this.scope} @Access`);
        }
        req.storage.AuthzHttpRoute = { domain: routeDomain(access), ...(access.unfilteredInput !== undefined ? { unfilteredInput: access.unfilteredInput } : {}) };
        const principal = req.storage.Principal;
        if (!principal) {
            throw unauthenticated('this route needs a principal');
        }
        if (!principal.authenticated && !access.anonymous) {
            throw unauthenticated('this route needs an authenticated principal');
        }
        const domain = rule.options.domain ?? 'root';
        const authz = await (await this.domains()).service(domain);
        const extracted = rule.options.resource ? await rule.options.resource(req) : undefined;
        if (rule.options.resource && (extracted === null || extracted === undefined)) {
            throw new InvalidArgument(`the resource extractor of ${controller.constructor.name}.${String(route.Method)} found no resource`, 'resource');
        }
        const resource = isUnloadedModel(extracted) ? await this.refOf(domain, extracted) : extracted;
        const decision = await this.inStore(req, () => this.decide(authz, domain, rule, principal, resource));
        if (!decision.allowed) {
            throw forbidden(decision, await this.inStore(req, () => this.trace(authz, domain, principal, decision)));
        }
        if (rule === (access.route ?? access.controller)) {
            req.storage.AuthzDecision = decision;
        }
    }
    // Not injected: @spinajs/telemetry builds this policy with `new`.
    async domains() {
        return (await DI.resolve(AuthzDomains));
    }
    /** In the request's store, so the checks share its per-request cache with the action's. */
    inStore(req, fn) {
        return authzStorage().run(req.storage, fn);
    }
    async decide(authz, domain, rule, principal, resource) {
        let denied;
        let subject;
        for (const permission of rule.permissions) {
            let decision = await authz.check({ principal, permission, resource: resource ?? { type: parsePermission(permission).resource } });
            if (decision.allowed && decision.residual.op !== 'true' && rule.options.subject === 'load') {
                subject ??= this.load(domain, decision.resource);
                const row = await subject;
                decision = row === null ? Object.freeze({ ...decision, allowed: false, residual: FALSE, reason: { code: 'unknown_resource' } }) : await authz.check({ principal, permission, resource: decision.resource, subject: row });
            }
            if (decision.allowed) {
                return decision;
            }
            denied ??= decision;
        }
        return denied;
    }
    /**
     * The ref the domain's adapter gives an unloaded `fromModel` instance. The instance itself must not
     * reach the engine, which would read its default field values as the row.
     */
    async refOf(domain, instance) {
        const adapters = [...(await (await this.domains()).container(domain).resolve(Array.chainOf(ResourceAdapter)))];
        const adapter = adapters.find((a) => a.accepts(instance));
        if (!adapter)
            throw new AuthzConfigError(`no ResourceAdapter of domain ${domain} accepts ${instance.constructor.name}`);
        return adapter.refOf(instance);
    }
    /** The row of `ref` from the first adapter of the domain that serves its type and can load; null when none can or the row is missing. */
    async load(domain, ref) {
        if (!isRef(ref) || ref.id === undefined)
            return null;
        const adapters = [...(await (await this.domains()).container(domain).resolve(Array.chainOf(ResourceAdapter)))];
        const adapter = adapters.find((a) => typeof a.load === 'function' && a.types.includes(ref.type));
        return adapter ? ((await adapter.load(ref)) ?? null) : null;
    }
    /**
     * The trace of a denial, outside production only, while the domain's `engine.explain` is on and
     * the caller holds the explain permission (`authz.http.explainRoute.permission`, B23, B41).
     */
    async trace(authz, domain, principal, denied) {
        if (isProduction(this.IsProduction))
            return undefined;
        const domains = await this.domains();
        if (!(domains instanceof DefaultAuthzDomains))
            return undefined;
        if (domainConfig(this.Authz, domains, domain).engine.explain !== true)
            return undefined;
        // A permission that never went through the schema (unset, malformed) must stay a denial, not a 500.
        const explain = await holdsExplain(authz, principal, this.ExplainPermission).catch(() => undefined);
        if (!explain?.held)
            return undefined;
        return (await authz.explain({ principal, permission: denied.permission, resource: denied.resource })).trace;
    }
};
__decorate([
    Config('authz.http.explainRoute.permission'),
    __metadata("design:type", String)
], AccessPolicy.prototype, "ExplainPermission", void 0);
__decorate([
    Config('authz'),
    __metadata("design:type", Object)
], AccessPolicy.prototype, "Authz", void 0);
__decorate([
    Config('configuration.isProduction'),
    __metadata("design:type", Object)
], AccessPolicy.prototype, "IsProduction", void 0);
AccessPolicy = __decorate([
    NewInstance(),
    __metadata("design:paramtypes", [String])
], AccessPolicy);
export { AccessPolicy };
//# sourceMappingURL=policy.js.map