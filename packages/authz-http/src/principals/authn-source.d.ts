import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { PrincipalSource } from '../api.js';
import '../storage.js';
/**
 * The principal authn-http resolved from a key, token or session and left in
 * `req.storage.AuthnPrincipal` (design §11.1, D26); a session still pending MFA leaves none.
 */
export declare class AuthnPrincipalSource extends PrincipalSource {
    readonly name = "authn";
    readonly order = 50;
    authenticate(req: Request): Promise<Principal | null>;
}
//# sourceMappingURL=authn-source.d.ts.map