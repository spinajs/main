import { RouteArgs } from '@spinajs/http';
import type { IRouteCall, IRouteParameter, Req } from '@spinajs/http';
import type * as express from 'express';
import '../storage.js';
/** Route arg of `@CurrentPrincipal()`: the request's principal, UNATTENDED without one (as `authz().current()`). */
export declare class CurrentPrincipalArg extends RouteArgs {
    get SupportedType(): string;
    extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: express.Request): Promise<{
        CallData: IRouteCall;
        Args: import("@spinajs/authz").Principal;
    }>;
}
/** The request's principal (design §11.1); `@User()` (users-http) stays the identity record. */
export declare function CurrentPrincipal(): ReturnType<typeof Req>;
//# sourceMappingURL=current-principal.d.ts.map