import { GLOBAL, SYSTEM, evaluateResidual, runWithPrincipal } from '@spinajs/authz';
import type { EvaluationContext, Principal, RelationResolver, ResourceFilter, ResourceRef, SubjectEnv, Truth } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { SelectQueryBuilder, createQuery, extractModelDescriptor } from '@spinajs/orm';
import type { IQueryStatement, UpdateQueryBuilder } from '@spinajs/orm';

import type { OrmScopePolicy } from './api.js';
import { columnsOf, dialectOf, idMode, idText, normalize } from './columns.js';
import { Unknown, insertedValue } from './insert.js';
import { scopePolicyOf } from './registry.js';
import type { ModelClass, ResourceEntry } from './registry.js';
import { ormRelations } from './relations.js';
import { pkOf } from './rows.js';
import type { Row } from './rows.js';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/**
 * Columns whose value the residual reads in memory: `cmp` fields, the `@Owner` column for
 * `relation owner`, and the `@ScopeColumn`s for `under` and `native:*` (native compilers scope by
 * them). An `@OrmScope` relation is its policy's `authorizeUpdate`'s business.
 */
export function columnsRead(f: ResourceFilter, entry: ResourceEntry): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (!isObject(node) || typeof node.op !== 'string') return;
    if (node.op === 'cmp' && typeof node.field === 'string') out.add(node.field);
    else if (node.op === 'relation' && node.relation === 'owner' && entry.owner !== undefined) out.add(entry.owner);
    else if (node.op === 'under' || node.op.startsWith('native:')) for (const s of entry.scopeColumns) out.add(s.column);
    else if (node.op === 'not') walk(node.arg);
    else if ((node.op === 'and' || node.op === 'or') && Array.isArray(node.args)) for (const a of node.args) walk(a);
  };
  walk(f);
  return out;
}

interface UpdateCheck {
  readonly model: ModelClass;
  readonly entry: ResourceEntry;
  /** The delegation principal. */
  readonly principal: Principal;
  readonly residual: ResourceFilter;
}

/** The rows the update reaches: a select with the update's statements (residual included), unscoped otherwise. */
function targetRows(builder: UpdateQueryBuilder<unknown>, model: ModelClass): Promise<Row[]> {
  return runWithPrincipal(SYSTEM, async () => {
    const { query } = createQuery(model as never, SelectQueryBuilder);
    // The update also reaches soft-deleted and archived rows.
    query.withDeleted().withArchived();
    const source = (builder as unknown as { _statements: IQueryStatement[] })._statements;
    (query as unknown as { _statements: IQueryStatement[] })._statements = source.map((s) => {
      const c = s.clone(query as never);
      c.Boolean = s.Boolean;
      return c;
    });
    return (await query) as unknown as Row[];
  });
}

/**
 * B20 for any residual: when the update writes a column the residual reads, every row it reaches
 * must still satisfy the residual with the written values over the stored ones. Returns false when
 * a row does not.
 */
export async function updateKeepsScope(builder: UpdateQueryBuilder<unknown>, c: UpdateCheck): Promise<boolean> {
  const written = { ...(builder.Value as Record<string, unknown>) };
  const reads = columnsRead(c.residual, c.entry);
  if (!Object.keys(written).some((k) => reads.has(k))) return true;

  const columns = columnsOf(c.model);
  const dialect = dialectOf(extractModelDescriptor(c.model as never));
  const pk = pkOf(c.model);
  const resolvers = ormRelations();
  const valueOf = (row: Row, column: string): unknown => (Object.hasOwn(written, column) ? written[column] : row[column]);

  for (const row of await targetRows(builder, c.model)) {
    const ref: ResourceRef = { type: c.entry.type, id: String(row[pk]) };
    const relation = async (name: string): Promise<Truth> => {
      if (name === 'owner' && c.entry.owner !== undefined) {
        const info = columns.get(c.entry.owner);
        if (!info || c.principal.type !== 'user' || typeof c.principal.id !== 'string') return false;
        return idText(idMode(info, dialect), valueOf(row, info.name)) === c.principal.id;
      }
      const cls = scopePolicyOf(c.model, name);
      if (cls !== undefined && typeof ((await DI.resolve(cls as never)) as OrmScopePolicy).authorizeUpdate === 'function') return true;
      const resolver = resolvers.find((r) => r.type === c.entry.type && r.relation === name);
      return resolver ? (await resolver.holds(c.principal, ref, row)) === true : undefined;
    };
    const env: SubjectEnv = {
      principal: c.principal,
      ref,
      attribute: (_subject, field) => {
        const info = columns.get(field);
        if (!info) return undefined;
        if (info.descriptor.Virtual || info.descriptor.Aggregate) throw new Unknown();
        return Object.hasOwn(written, field) ? insertedValue(info, true, written[field], dialect) : normalize(info.kind, row[field]);
      },
      relation: (type, name) => ({ type, relation: name, holds: () => relation(name) } as unknown as RelationResolver),
      ancestors: async () => {
        const out: ResourceRef[] = [ref];
        for (const s of c.entry.scopeColumns) {
          const info = columns.get(s.column);
          const id = info ? idText(idMode(info, dialect), valueOf(row, s.column)) : undefined;
          if (id !== undefined) out.push({ type: s.scopeType, id });
        }
        out.push(GLOBAL);
        return out;
      },
      native: () => undefined,
      ctx: {} as EvaluationContext,
    };
    if ((await evaluateResidual(c.residual, row, env)) !== true) return false;
  }
  return true;
}
