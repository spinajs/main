import type { Permission, Principal, ResourceRef, ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { BasePolicy, Request } from '@spinajs/http';
import type { ModelBase } from '@spinajs/orm';

// Takes the arguments so the stubs keep the design's parameter names under noUnusedParameters.
function notImplemented(name: string, ..._args: unknown[]): Error {
  return new Error(`@spinajs/authz-http: ${name} is not implemented yet`);
}

export abstract class PrincipalSource {
  abstract readonly name: string;
  abstract readonly order: number; // lower first; first non-null wins
  abstract authenticate(req: Request): Promise<Principal | null>;
}

export class LinkPrincipalSource extends PrincipalSource {
  readonly name = 'link';
  readonly order = 110;

  authenticate(req: Request): Promise<Principal | null> {
    throw notImplemented('LinkPrincipalSource.authenticate', req);
  }
}

// returns the request's principal; route-arg decorator in the style of @spinajs/http's Req()
export function CurrentPrincipal(): (target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => void {
  throw notImplemented('CurrentPrincipal');
}

export interface AccessOptions {
  resource?: ResourceExtractor; // default: type-level ref of the permission's resource
  also?: readonly Class<BasePolicy>[]; // same policy group (AND) (B23)
  domain?: string; // authz domain; default 'root'
  subject?: 'load' | 'none'; // 'load': adapter.load(ref) ⇒ definite 403 instead of a residual
  fields?: 'filter' | 'none'; // apply decision.fields.read to the response
}

export type ResourceExtractor = (req: Request) => ResourceRef | object | Promise<ResourceRef | object>;

export function Access(permission: Permission | readonly Permission[], opts?: AccessOptions): ClassDecorator & MethodDecorator {
  throw notImplemented('Access', permission, opts);
}

export function AllowAnonymous(): ClassDecorator & MethodDecorator {
  throw notImplemented('AllowAnonymous');
}

// ORM residuals not applied; audited (B09)
export function Unscoped(reason: string): MethodDecorator {
  throw notImplemented('Unscoped', reason);
}

export function fromParam(param: string, type: ResourceType, opts?: { by?: string }): ResourceExtractor {
  throw notImplemented('fromParam', param, type, opts);
}

export function fromBody(path: string, type: ResourceType): ResourceExtractor {
  throw notImplemented('fromBody', path, type);
}

export function fromQuery(param: string, type: ResourceType): ResourceExtractor {
  throw notImplemented('fromQuery', param, type);
}

// ref from @AccessResource
export function fromModel(model: Class<ModelBase>, param: string): ResourceExtractor {
  throw notImplemented('fromModel', model, param);
}

// read by http-swagger
export const ACCESS_DESCRIPTOR: unique symbol = Symbol.for('authz:access');
