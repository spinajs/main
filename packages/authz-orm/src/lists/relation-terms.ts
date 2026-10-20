import { AuthzConfigError } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';
import { Wrapper } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { PlanTermCompiler, RELATION_COLUMN_OP, RELATION_OWNER_OP, RELATION_SELF_OP } from '../plan/index.js';
import type { PlanRow } from '../plan/index.js';

type Where = IWhereBuilder<unknown>;
type Columns = { readonly column: string; readonly typeColumn?: string };

interface PrincipalArg {
  readonly type: string;
  readonly id: string;
}

function principalsOf(args: unknown, op: string): PrincipalArg[] {
  const list = (args as { principals?: unknown } | null)?.principals;
  if (!Array.isArray(list) || !list.every((p) => p !== null && typeof p === 'object' && typeof p.type === 'string' && p.type !== '' && typeof p.id === 'string')) {
    throw new AuthzConfigError(`authz-orm: ${op} args must be { principals: { type, id }[] }, got ${JSON.stringify(args)}`);
  }
  return list as PrincipalArg[];
}

function columnsOf(row: PlanRow, name: 'owner' | 'self'): Columns {
  const rel = row.relation(name);
  if (rel === undefined) throw new AuthzConfigError(`authz-orm: relation.${name}: resource type '${row.type}' has no ${name} column (@${name === 'owner' ? 'Owner' : 'Self'}())`);
  return rel;
}

/** The column, as text, is one of `ids`; none matches no row. */
function idIn(where: Where, column: string, ids: readonly string[]): void {
  where.whereIn(Wrapper.Text(column), [...new Set(ids)]);
}

const userIds = (principals: readonly PrincipalArg[]): string[] => principals.filter((p) => p.type === 'user').map((p) => p.id);

/** The columns hold one of the principals: a user id, or a type and id with `typeColumn`. */
function principalsMatch(where: Where, { column, typeColumn }: Columns, principals: readonly PrincipalArg[]): void {
  if (typeColumn === undefined) {
    idIn(where, column, userIds(principals));
    return;
  }
  const byType = new Map<string, string[]>();
  for (const p of principals) byType.set(p.type, [...(byType.get(p.type) ?? []), p.id]);
  if (byType.size === 0) {
    where.where(false);
    return;
  }
  for (const [type, ids] of byType) {
    where.orWhere(function () {
      this.where(typeColumn, type);
      idIn(this, column, ids);
    });
  }
}

/** The row's owner is one of the principals (design §5). */
@Singleton()
@Injectable(PlanTermCompiler)
export class RelationOwnerTerm extends PlanTermCompiler {
  readonly op = RELATION_OWNER_OP;

  apply(args: unknown, where: IWhereBuilder<unknown>, row: PlanRow): void {
    principalsMatch(where, columnsOf(row, 'owner'), principalsOf(args, this.op));
  }
}

/** The row is one of the user principals (`users` model, design §5). */
@Singleton()
@Injectable(PlanTermCompiler)
export class RelationSelfTerm extends PlanTermCompiler {
  readonly op = RELATION_SELF_OP;

  apply(args: unknown, where: IWhereBuilder<unknown>, row: PlanRow): void {
    idIn(where, columnsOf(row, 'self').column, userIds(principalsOf(args, this.op)));
  }
}

/** The row's column relation `relation` (`@Relation`) holds one of the principals. */
@Singleton()
@Injectable(PlanTermCompiler)
export class RelationColumnTerm extends PlanTermCompiler {
  readonly op = RELATION_COLUMN_OP;

  apply(args: unknown, where: IWhereBuilder<unknown>, row: PlanRow): void {
    const relation = (args as { relation?: unknown } | null)?.relation;
    if (typeof relation !== 'string' || relation === '') throw new AuthzConfigError(`authz-orm: ${this.op} args must be { relation, principals: { type, id }[] }, got ${JSON.stringify(args)}`);
    const columns = relation === 'owner' || relation === 'self' ? undefined : row.relation(relation);
    if (columns === undefined) throw new AuthzConfigError(`authz-orm: ${this.op}: resource type '${row.type}' has no column relation '${relation}' (@Relation('${relation}'))`);
    principalsMatch(where, columns, principalsOf(args, this.op));
  }
}
