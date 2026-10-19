import type { Principal, ResourceRef } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { BasePolicy, Request } from '@spinajs/http';
/** Built with `PrincipalMiddleware`, before the root authz boot: a source resolves `AuthzService` per call, it does not inject it. */
export declare abstract class PrincipalSource {
    abstract readonly name: string;
    abstract readonly order: number;
    abstract authenticate(req: Request): Promise<Principal | null>;
}
export interface AccessOptions {
    resource?: ResourceExtractor;
    also?: readonly Class<BasePolicy>[];
    domain?: string;
    subject?: 'load' | 'none';
    fields?: 'filter' | 'none';
}
export type ResourceExtractor = (req: Request) => ResourceRef | object | Promise<ResourceRef | object>;
export declare const ACCESS_DESCRIPTOR: unique symbol;
//# sourceMappingURL=api.d.ts.map