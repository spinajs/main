import { LinkResolver } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { Log } from '@spinajs/log';
import { PrincipalSource } from '../api.js';
import type { LinksConfig } from '../http-config.js';
import '../storage.js';
export { LinkResolver };
/** The link principal when no LinkResolver is registered: it denies every check. */
export declare function deadLinkPrincipal(companion?: Principal): Principal;
/**
 * A link token in the request (`authz.http.links`: query parameter, header or cookie, each
 * optional) replaces the principal the earlier sources found, which becomes its companion
 * (order 110, design §11.1, B38). PrincipalMiddleware runs it after the first-non-null sources.
 */
export declare class LinkPrincipalSource extends PrincipalSource {
    readonly name: 'link';
    readonly order: 110;
    protected Log: Log;
    protected Links: LinksConfig;
    private warned;
    authenticate(req: Request): Promise<Principal | null>;
    protected token(req: Request): string | undefined;
}
//# sourceMappingURL=link-source.d.ts.map