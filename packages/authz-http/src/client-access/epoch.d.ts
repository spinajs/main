import type { Principal } from '@spinajs/authz';
import { ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type * as express from 'express';
import '../storage.js';
export declare const ACCESS_EPOCH_HEADER = "X-Access-Epoch";
export declare const ACCESS_EPOCH_MIDDLEWARE_ORDER: number;
/**
 * Changes when the principal's access may change while no authz data does (design §10.4): login, role
 * switch, MFA elevation and impersonation all rotate the session, which changes `authn.sessionHandle`.
 */
export declare function accessEpoch(principal: Principal): string;
export declare class AccessEpochMiddleware extends ServerMiddleware {
    constructor();
    before(): (req: Request, res: express.Response, next: express.NextFunction) => void;
    after(): null;
}
//# sourceMappingURL=epoch.d.ts.map