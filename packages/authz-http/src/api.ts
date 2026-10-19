import type { Principal, ResourceRef } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { BasePolicy, Request } from '@spinajs/http';

/** Built with `PrincipalMiddleware`, before the root authz boot: a source resolves `AuthzService` per call, it does not inject it. */
export abstract class PrincipalSource {
  abstract readonly name: string;
  abstract readonly order: number; // lower first; first non-null wins
  abstract authenticate(req: Request): Promise<Principal | null>;
}

export interface AccessOptions {
  resource?: ResourceExtractor; // default: type-level ref of the permission's resource
  also?: readonly Class<BasePolicy>[]; // same policy group (AND) (B23)
  domain?: string; // authz domain; default 'root'
  subject?: 'load' | 'none'; // 'load': adapter.load(ref) ⇒ definite 403 instead of a residual
  fields?: 'filter' | 'none'; // apply decision.fields.read to the response
}

export type ResourceExtractor = (req: Request) => ResourceRef | object | Promise<ResourceRef | object>;

// read by http-swagger
export const ACCESS_DESCRIPTOR: unique symbol = Symbol.for('authz:access');
