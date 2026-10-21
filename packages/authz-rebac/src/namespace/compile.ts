import type { Permission, ResourceType } from '@spinajs/authz';

import type { NamespaceConfig, PermissionMap, Tuple } from '../contracts.js';

export type CompiledRewrite =
  | { readonly kind: 'computed'; readonly name: string }
  | { readonly kind: 'ttu'; readonly tupleset: string; readonly computed: string }
  | { readonly kind: 'union'; readonly children: readonly CompiledRewrite[] }
  | { readonly kind: 'intersection'; readonly children: readonly CompiledRewrite[] }
  | { readonly kind: 'exclusion'; readonly base: CompiledRewrite; readonly subtract: CompiledRewrite };

export interface CompiledRelation {
  readonly name: string;
  /** Types a direct subject may have (`'user'`, `'folder'`). */
  readonly direct: readonly ResourceType[];
  /** Subject sets a tuple may name (`group#member`). */
  readonly sets: readonly { readonly type: ResourceType; readonly relation: string }[];
}

export interface CompiledNamespace {
  readonly name: ResourceType;
  readonly relations: ReadonlyMap<string, CompiledRelation>;
  readonly permissions: ReadonlyMap<string, CompiledRewrite>;
}

/** Why a tuple does not fit the namespaces: the AuthzAdminFailure code and a message. */
export interface TupleProblem {
  readonly code: 'unknown_relation' | 'subject_not_allowed';
  readonly message: string;
}

/** Namespaces and the permission map, checked and compiled (design §3.3). */
export class NamespaceSchema {
  readonly namespaces: ReadonlyMap<ResourceType, CompiledNamespace> = new Map();
  /** Permission -> the relation or permission it asks for. */
  readonly targets: ReadonlyMap<Permission, { readonly type: ResourceType; readonly name: string }> = new Map();

  /** @throws AuthzConfigError naming the first problem */
  static compile(_namespaces: NamespaceConfig, _permissions: PermissionMap = {}): NamespaceSchema {
    throw new Error('not implemented: NamespaceSchema.compile');
  }

  relation(_type: ResourceType, _name: string): CompiledRelation | undefined {
    throw new Error('not implemented: NamespaceSchema.relation');
  }

  permission(_type: ResourceType, _name: string): CompiledRewrite | undefined {
    throw new Error('not implemented: NamespaceSchema.permission');
  }

  /** A relation or a permission of `type`. */
  has(_type: ResourceType, _name: string): boolean {
    throw new Error('not implemented: NamespaceSchema.has');
  }

  /** Why the tuple cannot be stored under these namespaces, or undefined. */
  problem(_tuple: Tuple): TupleProblem | undefined {
    throw new Error('not implemented: NamespaceSchema.problem');
  }

  /** Changes with any namespace or permission-map change. */
  hash(): string {
    throw new Error('not implemented: NamespaceSchema.hash');
  }
}
