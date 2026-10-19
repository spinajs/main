import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { PrincipalSource } from '../../src/index.js';
/**
 * `x-user: <id>` becomes `user:<id>`, signed in with session handle `x-session` when that header is set. Registered by
 * class: DI never returns factory registrations from Array.ofType.
 */
export declare class HeaderPrincipalSource extends PrincipalSource {
    readonly name = "test-header";
    readonly order = 0;
    authenticate(req: Request): Promise<Principal | null>;
}
export declare function registerHeaderSource(): () => void;
//# sourceMappingURL=principals.d.ts.map