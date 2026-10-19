import { BaseController, Ok } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Log } from '@spinajs/log';
import { AuthzDomains } from '@spinajs/authz';
import { AccessEventStream, SseAccessPushTransport } from '../client-access/sse.js';
import '../storage.js';
/** The caller's own access (design §10, §11.4), in the domain `authz.http.access.domain` (default root). */
export declare class AccessController extends BaseController {
    protected AccessDomain: string;
    protected Authz: unknown;
    protected Log: Log;
    protected Transport: SseAccessPushTransport;
    protected Domains: AuthzDomains;
    summary(req: Request): Promise<Ok<import("@spinajs/authz").AccessSummary>>;
    /** ckit's `createHttpChecker` wire format: `{ checks }` → `{ results, reasons }` (design §10.2). */
    checks(req: Request, checks: unknown[]): Promise<Ok<import("../client-access/checks.js").ClientChecksAnswer>>;
    /** `authz.changed` server-sent events for the caller (design §10.4); authenticated only, as the socket transport. */
    events(req: Request): Promise<AccessEventStream>;
}
//# sourceMappingURL=AccessController.d.ts.map