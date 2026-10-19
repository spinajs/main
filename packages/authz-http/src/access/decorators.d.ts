import type { Permission } from '@spinajs/authz';
import { RouteMiddleware } from '@spinajs/http';
import type { IController, IRoute, Response } from '@spinajs/http';
import type * as express from 'express';
import type { AccessOptions } from '../api.js';
import '../storage.js';
/**
 * Guards a route, or every route of a controller, with authorization (design §11.2). One policy
 * group: `AccessPolicy` AND the `also` policies (B23); other `@Policy` groups at the same place
 * stay alternatives (OR), and a class-level `@Access` narrows every route (http combines the
 * class and route scopes with AND). On a subclass it
 * replaces the inherited `@Access` group of that place instead of adding an alternative to it.
 */
export declare function Access(permission: Permission | readonly Permission[], opts?: AccessOptions): ClassDecorator & MethodDecorator;
/** Lets an unauthenticated principal (anonymous) pass the authentication part of `@Access`; without a principal the route still answers 401. */
export declare function AllowAnonymous(): ClassDecorator & MethodDecorator;
/**
 * Leaves the route's body input as the caller sent it: no `fields.write` and no `fields.neverRead`
 * filter. For routes whose body legitimately carries such fields, e.g. an admin creating a user
 * with a password; the reason documents why.
 */
export declare function UnfilteredInput(reason: string): ClassDecorator & MethodDecorator;
/**
 * Sets `req.storage.Unscoped` for the action, so the ORM applies no residual to the route's
 * queries, and audits the bypass (kind `unscoped`) in the route's domain (B09). Runs after the
 * policies: a refused request is no bypass.
 */
export declare class UnscopedMiddleware extends RouteMiddleware {
    readonly reason: string;
    constructor(reason: string);
    /** Called when http registers the route: an unguarded route must not run unscoped, so registration fails. */
    isEnabled(route: IRoute, controller: IController): boolean;
    onBefore(req: express.Request, _res: express.Response, route: IRoute, controller: IController): Promise<void>;
    onResponse(_response: Response): Promise<void>;
    onAfter(): Promise<void>;
}
export declare function Unscoped(reason: string): MethodDecorator;
//# sourceMappingURL=decorators.d.ts.map