import type { ResourceType } from '@spinajs/authz';
import { accessResourceModels, accessResourceTypeOf, scopePathOf } from '@spinajs/authz-orm/native';
import type { NativeScopePath } from '@spinajs/authz-orm/native';
import { Injectable } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { extractModelDescriptor } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import type { RbacScopeLayer } from './compile/attributes.js';
import { rbacDialectOf } from './compile/dialect.js';
import { FALSE_SQL, ident, rsql } from './compile/sql.js';
import type { RbacSql } from './compile/sql.js';
import { RbacScopePathSource } from './scope-path.js';
import type { RbacScopePath } from './scope-path.js';

/**
 * The default `RbacScopePathSource`: the path authz-orm's adapter gives a registered `@AccessResource`
 * model's rows (`ancestors`, `findRow`), id modes and the models registered before it for the same type
 * included, so `RbacPathSql` matches it. Registered in the root container when authz-rbac loads.
 * authz-orm's middleware resolves `RbacOrmCompiler` in the root container, so there only a root
 * registration made after authz-rbac loads overrides it; a registration in a child container counts for
 * a compiler resolved in that child.
 */
@Injectable(RbacScopePathSource)
export class OrmRbacScopePathSource extends RbacScopePathSource {
  path(model: Class<ModelBase>): RbacScopePath | null {
    const p = scopePathOf(model);
    if (p === null) return null;
    return {
      type: p.type,
      idColumn: p.id.column,
      idMode: p.id.idMode,
      scopes: p.scopes.map((s) => ({ column: s.column, scopeType: s.scopeType, idMode: s.idMode })),
      earlierKeys: p.before.map((k) => (k === null ? null : { table: k.table, idColumn: k.id.column, idMode: k.id.idMode })),
    };
  }
}

const NODE = 'authz_n';

/**
 * The attribute layer (`RbacScopeLayer`) of each scope type authz-orm's adapter serves, for SQL on
 * `driver`'s connection. Its `scopeAttributes` answers the node row's `@AccessResource` attributes,
 * or null (the engine faults) when `findRow` finds no row. So a type of exactly one model on this
 * connection is `adapter` with those names and an `exists` test for the node row by its primary key,
 * read as `findRow` reads it. A type of several models is `adapter` without `exists`, every read a
 * fault: `findRow` takes the first model that has a row, which SQL does not follow. So is a type whose
 * model lives on another connection. A type with a model whose table or key cannot be read is left out,
 * as are the types authz-orm does not serve (undeclared: faults); declare `store` types (and GLOBAL,
 * which is `store` by default) next to these.
 */
export function ormRbacScopeLayers(driver: OrmDriver): Record<ResourceType, RbacScopeLayer> {
  const out: Record<ResourceType, RbacScopeLayer> = {};
  const byType = new Map<ResourceType, Class<ModelBase>[]>();
  for (const model of accessResourceModels()) {
    const type = accessResourceTypeOf(model);
    if (type !== undefined) byType.set(type, [...(byType.get(type) ?? []), model]);
  }
  for (const [type, models] of byType) {
    const paths = readable(models);
    if (paths === undefined) continue;
    const attributes = [...new Set(paths.flatMap((p) => p.attributes))];
    const single = models.length === 1 && extractModelDescriptor(models[0] as never)?.Driver === driver ? paths[0] : undefined;
    out[type] = single === undefined ? { kind: 'adapter', attributes } : { kind: 'adapter', attributes, exists: nodeRowExists(single, driver) };
  }
  return out;
}

function readable(models: readonly Class<ModelBase>[]): NativeScopePath[] | undefined {
  try {
    return models.map((m) => scopePathOf(m)!);
  } catch {
    return undefined;
  }
}

/** `exists` of a model's layer: a row whose primary key, read as `findRow` reads it, is the node id. */
function nodeRowExists({ table, id }: NativeScopePath, driver: OrmDriver): (nodeId: RbacSql) => RbacSql {
  if (id.idMode === 'none') return () => FALSE_SQL;
  const dialect = rbacDialectOf(driver);
  const read = dialect.idOf(rsql`${ident(NODE, id.column)}`, id.idMode);
  return (nodeId) => rsql`EXISTS (SELECT 1 FROM ${ident(table)} ${ident(NODE)} WHERE ${read.findable} AND ${read.exact} AND ${dialect.sameText(read.text, nodeId)})`;
}
