import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

export interface RbacScopeColumn {
  /** Column of the model's table holding the ancestor's id. */
  readonly column: string;
  readonly scopeType: ResourceType;
}

/** Where a row sits in the resource tree, as the SQL sees it. */
export interface RbacScopePath {
  /** Resource type of the model's rows. */
  readonly type: ResourceType;
  /** Column holding the row's own resource id. */
  readonly idColumn: string;
  /** `@ScopeColumn`s, nearest ancestor first (the order of `ancestors()`). */
  readonly scopes: readonly RbacScopeColumn[];
}

/**
 * Scope path of a model class. authz-orm owns the metadata (`@AccessResource`,
 * `@ScopeColumn`), so it registers the implementation; there is no default.
 */
export abstract class RbacScopePathSource {
  /** null: the model is not an access resource. */
  abstract path(model: Class<ModelBase>): RbacScopePath | null;
}
