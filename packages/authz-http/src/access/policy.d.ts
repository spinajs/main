import { AccessDenied, AuthzDomains, Unauthenticated } from '@spinajs/authz';
import type { AuthzService, Decision, DenyReason, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import type { IAccessRule } from './descriptor.js';
import '../storage.js';
export type AccessScope = 'route' | 'class';
/** 401 body: `{ error: 'unauthenticated', message }`. */
export declare function unauthenticated(message: string): Unauthenticated;
/** The reason as the 403 body shows it: its payload without the ordering keys (design §11.2). */
export declare function publicReason(reason: DenyReason | undefined): Omit<DenyReason, 'priority' | 'sortKey'> | undefined;
/** AccessDenied whose enumerable props are the 403 body `{ error, permission, resource, reason, trace? }`; http spreads them into the response. */
export declare function forbidden(decision: Decision, trace?: unknown): AccessDenied;
/** The check of the explain permission; only an unconditional grant holds it, since nothing on the explain paths would enforce a residual. */
export declare function holdsExplain(authz: AuthzService, principal: Principal, permission: Permission): Promise<{
    readonly held: boolean;
    readonly decision: Decision;
}>;
/**
 * Decides the `@Access` of its scope (design §11.2), read from the controller's descriptor at
 * request time: a request without a principal, or with an unauthenticated one on a route without
 * `@AllowAnonymous`, is refused 401; several permissions mean any of them; a denial throws a 403
 * with `{ error, permission, resource, reason }`. With `subject: 'load'` a conditional allow is
 * settled against the row the domain's adapter loads. The allowing decision of the route's own
 * `@Access` (else the class's) goes to `req.storage.AuthzDecision`.
 */
export declare class AccessPolicy extends BasePolicy {
    readonly scope: AccessScope;
    protected ExplainPermission: Permission;
    protected Authz: unknown;
    protected IsProduction: boolean | undefined;
    constructor(scope: AccessScope);
    isEnabled(): boolean;
    execute(req: Request, route: IRoute, controller: IController): Promise<void>;
    protected domains(): Promise<AuthzDomains>;
    /** In the request's store, so the checks share its per-request cache with the action's. */
    protected inStore<T>(req: Request, fn: () => Promise<T>): Promise<T>;
    protected decide(authz: AuthzService, domain: string, rule: IAccessRule, principal: Principal, resource: ResourceRef | object | undefined): Promise<Decision>;
    /**
     * The ref the domain's adapter gives an unloaded `fromModel` instance. The instance itself must not
     * reach the engine, which would read its default field values as the row.
     */
    protected refOf(domain: string, instance: object): Promise<ResourceRef>;
    /** The row of `ref` from the first adapter of the domain that serves its type and can load; null when none can or the row is missing. */
    protected load(domain: string, ref: ResourceRef): Promise<unknown>;
    /**
     * The trace of a denial, outside production only, while the domain's `engine.explain` is on and
     * the caller holds the explain permission (`authz.http.explainRoute.permission`, B23, B41).
     */
    protected trace(authz: AuthzService, domain: string, principal: Principal, denied: Decision): Promise<unknown>;
}
//# sourceMappingURL=policy.d.ts.map