import { AuthzConfigError, PlanTermSql } from '@spinajs/authz';
import type { SqlFragment, SqlRowContext } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { castText } from './dialect.js';

export const RELATION_OWNER_OP = 'relation.owner';
export const RELATION_SELF_OP = 'relation.self';

const NOTHING: SqlFragment = Object.freeze({ sql: '1 = 0', bindings: [] });

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

function columnsOf(row: SqlRowContext, name: 'owner' | 'self'): { column: string; typeColumn?: string } {
  const rel = row.relation(name);
  if (rel === undefined) throw new AuthzConfigError(`authz-orm: relation.${name}: resource type '${row.type}' has no ${name} column (@${name === 'owner' ? 'Owner' : 'Self'}())`);
  return rel;
}

function idIn(row: SqlRowContext, column: string, ids: readonly string[]): SqlFragment {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return NOTHING;
  return { sql: `${castText(row.dialect, row.rowColumn(column))} IN (${unique.map(() => '?').join(', ')})`, bindings: unique };
}

const userIds = (principals: readonly PrincipalArg[]): string[] => principals.filter((p) => p.type === 'user').map((p) => p.id);

/** The row's owner is one of the principals (design §5): a user id, or a type and id with `typeColumn`. */
@Singleton()
@Injectable(PlanTermSql)
export class RelationOwnerSql extends PlanTermSql {
  readonly op = RELATION_OWNER_OP;

  toSql(args: unknown, row: SqlRowContext): SqlFragment {
    const principals = principalsOf(args, this.op);
    const { column, typeColumn } = columnsOf(row, 'owner');
    if (typeColumn === undefined) return idIn(row, column, userIds(principals));
    const byType = new Map<string, string[]>();
    for (const p of principals) byType.set(p.type, [...(byType.get(p.type) ?? []), p.id]);
    const parts = [...byType].map(([type, ids]) => {
      const match = idIn(row, column, ids);
      return { sql: `${row.rowColumn(typeColumn)} = ? AND ${match.sql}`, bindings: [type, ...match.bindings] };
    });
    if (parts.length === 0) return NOTHING;
    if (parts.length === 1) return parts[0];
    return { sql: parts.map((x) => `(${x.sql})`).join(' OR '), bindings: parts.flatMap((x) => x.bindings) };
  }
}

/** The row is one of the user principals (`users` model, design §5). */
@Singleton()
@Injectable(PlanTermSql)
export class RelationSelfSql extends PlanTermSql {
  readonly op = RELATION_SELF_OP;

  toSql(args: unknown, row: SqlRowContext): SqlFragment {
    return idIn(row, columnsOf(row, 'self').column, userIds(principalsOf(args, this.op)));
  }
}
