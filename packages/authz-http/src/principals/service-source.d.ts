import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { PrincipalSource } from '../api.js';
import type { ServiceEntry } from '../http-config.js';
/**
 * `service:<name>` for a request whose configured header carries one of the service's tokens
 * (`authz.http.services`, design §11.1). Runs before the authn principal (order 40 < 50), so a
 * configured service header wins over any authn credential. A wrong token yields nothing: the
 * header may be one other credentials share.
 */
export declare class ServicePrincipalSource extends PrincipalSource {
    readonly name = "service";
    readonly order = 40;
    protected Services: readonly ServiceEntry[] | undefined;
    authenticate(req: Request): Promise<Principal | null>;
}
//# sourceMappingURL=service-source.d.ts.map