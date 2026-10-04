import { IdentifierQuoter, RelationType, SelectQueryBuilder, extractModelDescriptor } from '@spinajs/orm';
import type { IQueryStatement, IQueryStatementResult, IRelationDescriptor, IWhereBuilder } from '@spinajs/orm';

import { entryOf } from './registry.js';
import { AuthzStatement } from './shield.js';

interface Aliased {
  readonly TableAlias?: string;
  readonly Table?: string;
}

const nameOf = (b: Aliased | undefined): string | undefined => b?.TableAlias || b?.Table || undefined;

/**
 * `<query>.<column> = <the query it is correlated with>.<outer column>`. Both names are read when the
 * statement builds: the outer query may get its alias later (`populate()`), and a clone of the query
 * is correlated with the clone of the outer one.
 */
export class Correlation extends AuthzStatement {
  constructor(readonly target: SelectQueryBuilder, private readonly column: string, private readonly outerColumn: string) {
    super();
  }

  build(): IQueryStatementResult {
    const quoter = this.target.Driver.Container.resolve<IdentifierQuoter>(IdentifierQuoter as never);
    const own = nameOf(this.target as Aliased);
    const outer = nameOf(this.target.CorrelationSource as Aliased | undefined);
    // Without its outer query, or under the outer query's own name, the EXISTS would not test the outer row: render FALSE.
    if (own === undefined || outer === undefined || own === outer) return { Statements: ['(1 = 0)'], Bindings: [] };
    return { Statements: [`${quoter.quote(own)}.${quoter.quote(this.column)} = ${quoter.quote(outer)}.${quoter.quote(this.outerColumn)}`], Bindings: [] };
  }

  clone<T>(parent?: T): IQueryStatement {
    return this.derived(new Correlation((parent ?? this.target) as unknown as SelectQueryBuilder, this.column, this.outerColumn));
  }
}

// Junction sub-queries built here; an EXISTS over a junction the orm builds itself fails closed.
const vetted = new WeakSet<object>();

export const carryVetted = (from: object, to: object): void => {
  if (vetted.has(from)) vetted.add(to);
};

function relationOf(model: unknown, name: string): IRelationDescriptor | undefined {
  // As the orm's getRelationDescriptor matches it.
  const wanted = name.toLowerCase().trim();
  for (const [key, rel] of extractModelDescriptor(model as never)?.Relations ?? []) if (key.toLowerCase() === wanted) return rel;
  return undefined;
}

type Static = { query(): SelectQueryBuilder };

/**
 * `whereExist('<many-to-many>')` as the orm builds it reads only the junction table, so it would tell
 * whether a row links to targets the principal cannot read. Here the EXISTS goes over the junction
 * and then the target, whose query the middleware scopes like any other:
 * `EXISTS (SELECT * FROM junction j WHERE j.source = outer.pk AND EXISTS (SELECT * FROM target t WHERE
 * (residual) AND t.pk = j.target AND (callback)))`.
 */
function junctionExists(outer: IWhereBuilder<unknown>, rel: IRelationDescriptor, callback?: (this: unknown) => void): SelectQueryBuilder {
  const junction = rel.JunctionModel as unknown as Static;
  const target = rel.TargetModel as unknown as Static;
  const links = junction
    .query()
    .setAlias(`${extractModelDescriptor(junction as never)!.TableName}_exists`)
    .correlateWith(outer);
  links.Statements.push(new Correlation(links, rel.JunctionModelSourceModelFKey_Name!, rel.PrimaryKey));
  const rows = target
    .query()
    .setAlias(`${extractModelDescriptor(target as never)!.TableName}_exists`)
    .correlateWith(links as never);
  rows.Statements.push(new Correlation(rows, rel.ForeignKey, rel.JunctionModelTargetModelFKey_Name!));
  if (callback) callback.call(rows);
  links.whereExist(rows);
  vetted.add(links);
  return links;
}

const wrapped = new WeakSet<object>();

/** A many-to-many `whereExist`/`whereNotExists` on a scoped target tests the target rows the residual allows. */
export function scopeManyToManyExists(builder: object): void {
  if (wrapped.has(builder)) return;
  wrapped.add(builder);
  const original = (builder as { buildExistsClause?: (...a: unknown[]) => unknown }).buildExistsClause;
  if (typeof original !== 'function') return;
  Object.defineProperty(builder, 'buildExistsClause', {
    configurable: true,
    writable: true,
    value: function (this: IWhereBuilder<unknown>, query: unknown, negated: boolean, callback?: (this: unknown) => void) {
      const rel = typeof query === 'string' ? relationOf((this as { Model?: unknown }).Model, query) : undefined;
      if (rel === undefined || rel.Type !== RelationType.ManyToMany || !entryOf(rel.TargetModel)) return original.call(this, query, negated, callback);
      return original.call(this, junctionExists(this, rel, callback), negated);
    },
  });
}

/** A correlated sub-query of a junction table whose relation's target is scoped, built by the orm (it reads the junction only). */
export function unvettedJunction(builder: SelectQueryBuilder): boolean {
  if (vetted.has(builder)) return false;
  const source = builder.CorrelationSource as { Model?: unknown } | undefined;
  const model = builder.Model as { name?: string } | undefined;
  if (source === undefined || model === undefined) return false;
  for (const rel of extractModelDescriptor(source.Model as never)?.Relations.values() ?? []) {
    const junction = rel.JunctionModel as { name?: string } | undefined;
    if (rel.Type === RelationType.ManyToMany && junction !== undefined && (junction === model || junction.name === model.name) && entryOf(rel.TargetModel)) return true;
  }
  return false;
}
