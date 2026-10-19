import { BasePolicy } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import '../storage.js';
/** Passes for any principal, anonymous included; 401 when the request has none. */
export declare class HasPrincipal extends BasePolicy {
    isEnabled(): boolean;
    execute(req: Request): Promise<void>;
}
/** Passes for an authenticated principal only; 401 otherwise. */
export declare class IsAuthenticated extends BasePolicy {
    isEnabled(): boolean;
    execute(req: Request): Promise<void>;
}
//# sourceMappingURL=principal-policies.d.ts.map