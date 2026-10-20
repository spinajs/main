import { AuthzService } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Log } from '@spinajs/log';
import type * as express from 'express';
import { PrincipalSource } from '../api.js';
import '../storage.js';
/** The principal of a request no source recognised, while `authz.principals.anonymous.enabled` is on. */
export declare const ANONYMOUS: Principal;
/** Runs after authn-http's AuthnMiddleware (Order 5), which leaves its principal in `req.storage.AuthnPrincipal`. */
export declare const PRINCIPAL_MIDDLEWARE_ORDER = 10;
/**
 * Resolves the request's principal (design §11.1): the registered `PrincipalSource`s run in ascending
 * `order` and the first non-null answer wins; with none, the anonymous principal when
 * `authz.principals.anonymous.enabled`, else no principal at all. The principal goes to
 * `req.storage.Principal`, the store the action's AsyncLocalStorage runs with, and the root
 * domain preloads it in that store.
 */
export declare class PrincipalMiddleware extends ServerMiddleware {
    protected Log: Log;
    protected AnonymousEnabled: boolean;
    protected Sources: PrincipalSource[];
    private authz;
    constructor();
    resolve(): Promise<void>;
    dispose(): Promise<void>;
    private readonly onListening;
    before(): (req: Request, res: express.Response, next: express.NextFunction) => void;
    after(): null;
    /** The root AuthzService, booted once; `authz()` works in actions after it. */
    protected rootService(): Promise<AuthzService>;
    protected attach(req: Request): Promise<void>;
    /**
     * First non-null of the plain sources; then a link source may replace it, with it as the link's
     * companion (left in req.storage.Principal for the link source to read).
     */
    protected authenticate(req: Request): Promise<Principal | null>;
    protected ask(source: PrincipalSource, req: Request): Promise<Principal | null>;
}
//# sourceMappingURL=middleware.d.ts.map