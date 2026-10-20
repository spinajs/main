import { AuthzDomains } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';
import { BaseController, BasePolicy, Ok } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import '../storage.js';
/** Allows a caller who holds `authz.http.explainRoute.permission` in the access domain. */
export declare class ExplainPolicy extends BasePolicy {
    protected AccessDomain: string;
    protected ExplainPermission: Permission;
    protected Domains: AuthzDomains;
    isEnabled(): boolean;
    execute(req: Request): Promise<void>;
}
/**
 * `GET /authz/explain?principal=<type>:<id>&permission=&resource=<type>[:<id>]&format=decision|tree`: the decision with
 * its trace (design §11.4). Mounted only by ExplainControllerSource: when
 * `authz.http.explainRoute.enabled` and never in production (H19, B41).
 */
export declare class ExplainController extends BaseController {
    protected AccessDomain: string;
    protected Domains: AuthzDomains;
    explain(_req: Request, principal: string, permission: string, resource?: string, format?: string): Promise<Ok<import("@spinajs/authz").Decision | import("./tree.js").ExplainNode>>;
}
//# sourceMappingURL=controller.d.ts.map