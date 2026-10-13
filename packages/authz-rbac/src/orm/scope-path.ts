import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

/**
 * How the resource adapter reads a column's value as an id (authz-orm's `IdMode`): `string` a text
 * value, `number` a finite number within the safe integers (its canonical text), `text` a value whose
 * text cast is the id (Postgres uuid, int8, numeric), `none` never an id.
 */
export type RbacIdMode = 'string' | 'number' | 'text' | 'none';

export interface RbacScopeColumn {
  /** Column of the model's table holding the ancestor's id. */
  readonly column: string;
  readonly scopeType: ResourceType;
  /** Absent: any non-NULL value is an id, compared as its text cast. */
  readonly idMode?: RbacIdMode;
}

/** A model's table and primary key, as the adapter's `findRow` reads it. */
export interface RbacModelKey {
  readonly table: string;
  readonly idColumn: string;
  readonly idMode: RbacIdMode;
}

/** Where a row sits in the resource tree, as the SQL sees it. */
export interface RbacScopePath {
  /** Resource type of the model's rows. */
  readonly type: ResourceType;
  /** Column holding the row's own resource id. */
  readonly idColumn: string;
  /** Of `idColumn`. Absent: the adapter finds every row by its id, compared as its text cast. */
  readonly idMode?: RbacIdMode;
  /** `@ScopeColumn`s, nearest ancestor first (the order of `ancestors()`). */
  readonly scopes: readonly RbacScopeColumn[];
  /**
   * The models of the type registered before this one (`findRow` tries them first, and a row whose id one of
   * them holds gets that row's path); null for one this connection cannot read. Needs `idMode`.
   */
  readonly earlierKeys?: readonly (RbacModelKey | null)[];
}

/**
 * Scope path of a model class. The default, `OrmRbacScopePathSource`, reads authz-orm's
 * `@AccessResource` and `@ScopeColumn` metadata. authz-orm's middleware resolves `RbacOrmCompiler` in the
 * root container, so there only a root registration made after authz-rbac loads overrides the default; a
 * registration in a child container counts for a compiler resolved in that child. A host source must give
 * the adapter's view: for a type several models share, `earlierKeys` (else a later model's rows the adapter
 * reads from an earlier model are listed by their own path, which is wider), and for a subclass the key and
 * scope columns of the class the adapter loads.
 */
export abstract class RbacScopePathSource {
  /** null: the model is not an access resource. */
  abstract path(model: Class<ModelBase>): RbacScopePath | null;
}
