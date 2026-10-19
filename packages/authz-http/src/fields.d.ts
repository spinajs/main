import { AuthzDomains } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { ArgInputFilter, DataTransformer, RouteMiddleware } from '@spinajs/http';
import type { IController, IRoute, IRouteParameter, Response } from '@spinajs/http';
import type * as express from 'express';
/** Route args that carry what the caller writes; query, url, header and cookie args are not writes. */
export declare const BODY_ARGS: ReadonlySet<string>;
export interface DecisionFields {
    readonly read: readonly string[];
    readonly write: readonly string[];
    readonly writeMode: 'strip' | 'reject';
}
/**
 * The decision's field sets without the domain's `fields.neverRead`, and the domain's write mode
 * (design §11.3, B17). Without a decision (a route another policy group admitted) only
 * `neverRead` applies, in the route's domain. `authz` is the `authz` section its caller reads through @Config.
 */
export declare function decisionFields(authz: unknown, domains: AuthzDomains, decision: Decision | undefined, domain?: string): DecisionFields;
/**
 * Strips, or in `reject` mode refuses with 400, the body input the route's decision does not let
 * the caller write (`decision.fields.write` minus `fields.neverRead`, design §11.3, B17). A named
 * primitive body field is checked by its name. A route another policy group admitted (no decision)
 * still loses `neverRead`; a route without `@Access`, or with `@UnfilteredInput`, is not filtered.
 */
export declare class AuthzInputFieldFilter extends ArgInputFilter {
    protected Authz: unknown;
    protected Domains: AuthzDomains;
    filter(input: unknown, parameter: IRouteParameter): unknown;
}
/** `x-data-transform: authz-fields`: the response data limited to what the route's decision lets the caller read. */
export declare class AuthzFieldTransformer extends DataTransformer {
    protected Authz: unknown;
    protected Domains: AuthzDomains;
    get Type(): string;
    transform(data: unknown, request: express.Request): unknown;
}
/** Added by `@Access(…, { fields: 'filter' })`: the response data limited to `decision.fields.read` (B17). */
export declare class AuthzFieldsMiddleware extends RouteMiddleware {
    protected Authz: unknown;
    protected Domains: AuthzDomains;
    isEnabled(route: IRoute, controller: IController): boolean;
    onBefore(): Promise<void>;
    onResponse(response: Response, route: IRoute, controller: IController): Promise<void>;
    onAfter(): Promise<void>;
}
//# sourceMappingURL=fields.d.ts.map