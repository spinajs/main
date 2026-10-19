import { DI } from '@spinajs/di';
import { userPrincipal, withAuthn } from '@spinajs/authz-testing';
import { PrincipalSource } from '../../src/index.js';
/**
 * `x-user: <id>` becomes `user:<id>`, signed in with session handle `x-session` when that header is set. Registered by
 * class: DI never returns factory registrations from Array.ofType.
 */
export class HeaderPrincipalSource extends PrincipalSource {
    constructor() {
        super(...arguments);
        this.name = 'test-header';
        this.order = 0;
    }
    async authenticate(req) {
        const id = req.headers['x-user'];
        const session = req.headers['x-session'];
        if (typeof id !== 'string' || id.length === 0)
            return null;
        return typeof session === 'string' && session.length > 0 ? withAuthn(userPrincipal(id), { sessionHandle: session }) : userPrincipal(id);
    }
}
export function registerHeaderSource() {
    DI.register(HeaderPrincipalSource).as(PrincipalSource);
    return () => {
        DI.unregister(HeaderPrincipalSource);
        DI.uncache(HeaderPrincipalSource);
        DI.uncache(PrincipalSource);
    };
}
//# sourceMappingURL=principals.js.map