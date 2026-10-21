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
  subject?: 'load' | 'none'; // 'load': same as conditional: 'load'
  /** 'load' (default): a conditional allow on a resource with an id loads the row and checks again; 'action': the action checks the residual itself. */
  conditional?: 'load' | 'action';
  fields?: 'filter' | 'none'; // apply decision.fields.read to the response
}

export type ResourceExtractor = (req: Request) => ResourceRef | object | Promise<ResourceRef | object>;

// read by http-swagger
export const ACCESS_DESCRIPTOR: unique symbol = Symbol.for('authz:access');
