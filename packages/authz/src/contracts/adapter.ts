import type { Principal, ResourceRef, ResourceType } from './principal.js';
import type { Permission, PermissionDef } from './permission.js';
import type { FilterOp } from './filter.js';

export abstract class ResourceAdapter<T = unknown> {
  abstract readonly kind: string; // 'orm' | 'fs' | 'queue' | app
  abstract readonly types: readonly ResourceType[];
  abstract accepts(target: unknown): target is T;
  abstract refOf(target: T): ResourceRef | Promise<ResourceRef>;
  /** [self, parent, ..., GLOBAL]; null = unknown resource. */
  abstract ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null>;
  scopeAttributes?(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null>; // values for 'scope.<type>.*' refs
  load?(ref: ResourceRef): Promise<unknown | null>; // subject loader for definite answers
  attribute?(subject: unknown, field: string): unknown; // in-memory 'cmp' reads; default subject[field]
  relations?(): readonly RelationResolver[];
  permissions?(): readonly Omit<PermissionDef, 'source'>[];
  operations?(): Readonly<Record<string, Permission | readonly Permission[]>>; // proxies, docs
  /** Filter ops this adapter compiles into its query language; undefined = not list-scoped. */
  readonly compiles?: readonly FilterOp[];
}

export abstract class ScopeResolver {
  abstract readonly types: readonly ResourceType[];
  abstract ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null>;
  /** Attributes of one node for 'scope.<type>.*' and 'resource.*' refs (canvas: org policies, branch name). Must fill defaults. */
  attributes?(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null>;
}
// Unregistered type: ancestors = [ref, GLOBAL]; attributes = {}.
// A condition or rule that reads a missing scope attribute makes the vote indeterminate (B04, fail closed; B39).

export abstract class RelationResolver {
  abstract readonly type: ResourceType;
  abstract readonly relation: string; // 'owner' | 'self' | 'pool' | 'polsat' | 'initiator' | 'editor'
  abstract holds(principal: Principal, ref: ResourceRef, subject?: unknown): boolean | Promise<boolean>;
}

/** Scope attributes as authz data: ctx.attributes(ref) = schema defaults ⊕ adapter/resolver attributes ⊕ store rows (store wins). */
export interface ScopeAttributeSchema {
  readonly scopeType: ResourceType;
  readonly schema: object; // JSON schema of the attribute object, scalars at the leaves
  readonly defaults: Readonly<Record<string, unknown>>;
}

export abstract class ScopeAttributeStore {
  abstract get(ref: ResourceRef): Promise<Readonly<Record<string, unknown>>>; // nested object rebuilt from flat paths
  abstract version(): Promise<string>;
}
