import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

// Takes the arguments so the stubs keep the design's parameter names under noUnusedParameters.
function notImplemented(name: string, ..._args: unknown[]): Error {
  return new Error(`@spinajs/authz-orm: ${name} is not implemented yet`);
}

export interface ParentOptions {
  /** A NULL column means "no parent" (a root); without it `authz:ancestors-verify` reports NULLs. */
  readonly nullable?: boolean;
}

export interface OwnerOptions {
  /** A column holding the owner's principal type; without it the owner is always a `user`. */
  readonly typeColumn?: string;
}

export interface AccessResourceOptions {
  /** The `@Parent` columns of a model the package does not own. */
  readonly parents?: readonly { readonly column: string; readonly type: ResourceType }[];
  /** The `owner` column (the user whose id it holds), or the id column plus a principal type column. */
  readonly owner?: string | { readonly column: string; readonly typeColumn?: string };
  /** The `self` column: the row is the user whose id it holds. */
  readonly self?: string;
}

// default permissions: `${type}:read|create|update|delete`; several models may share one type (B21)
export function AccessResource(type: ResourceType): ClassDecorator {
  throw notImplemented('AccessResource', type);
}

// the column holds the id of the parent resource of `type`; several parents and self-references are allowed
export function Parent(type: ResourceType, opts?: ParentOptions): PropertyDecorator {
  throw notImplemented('Parent', type, opts);
}

// relation 'owner' on the model's type
export function Owner(opts?: OwnerOptions): PropertyDecorator {
  throw notImplemented('Owner', opts);
}

// relation 'self' on the model's type
export function Self(): PropertyDecorator {
  throw notImplemented('Self');
}

// for models a package does not own (JobModel, DbConfig)
export function registerAccessResource(model: Class<ModelBase>, type: ResourceType, opts?: AccessResourceOptions): void {
  throw notImplemented('registerAccessResource', model, type, opts);
}

// writes `column` (default: the model's only @Parent) of the rows `ids` in one transaction; resolves with the rows changed
export function reparent(model: Class<ModelBase>, ids: readonly (string | number)[], newParentId: string | number | null, column?: string): Promise<number> {
  throw notImplemented('reparent', model, ids, newParentId, column);
}
