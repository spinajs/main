import { PlanTermSql } from '@spinajs/authz';
import type { PrincipalRef, SqlFragment, SqlRowContext } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { parsePrincipalSubjectKey } from '../model/sets/keys.js';
import { AUTHZ_ASSIGNMENT_TABLE } from '../stores/assignment-row.js';
import { AUTHZ_SUBJECT_MEMBERSHIP_TABLE } from '../stores/index.js';
import { RBAC_ASSIGNMENT_PLAN_OP, parseRbacPlanArgs } from './args.js';
import type { RbacAssignmentPlanArgs, RbacPlanRole } from './args.js';

const GLOBAL_TYPE = '$global';
const FALSE_SQL: SqlFragment = Object.freeze({ sql: '(1 = 0)', bindings: Object.freeze([]) });

const raw = (sql: string): SqlFragment => ({ sql, bindings: [] });
const isFragment = (v: unknown): v is SqlFragment => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && typeof (v as SqlFragment).sql === 'string' && Array.isArray((v as SqlFragment).bindings);

/** A fragment is inlined, an array becomes `?, ?, …` (never empty here), anything else one `?`. */
function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  let text = strings[0];
  const bindings: unknown[] = [];
  values.forEach((v, i) => {
    if (isFragment(v)) {
      text += v.sql;
      bindings.push(...v.bindings);
    } else if (Array.isArray(v)) {
      text += v.map(() => '?').join(', ');
      bindings.push(...v);
    } else {
      text += '?';
      bindings.push(v);
    }
    text += strings[i + 1];
  });
  return { sql: text, bindings };
}

const join = (separator: string, list: readonly SqlFragment[]): SqlFragment => ({ sql: list.map((f) => f.sql).join(separator), bindings: list.flatMap((f) => f.bindings) });

/** As SqlDatetimeValueConverter writes a datetime on SQLite (local wall clock, no zone): text order is time order. */
export function sqliteDateTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const nowOf = (row: SqlRowContext): unknown => (row.dialect === 'sqlite' ? sqliteDateTime(row.now) : row.now);
const live = (alias: string, now: unknown): SqlFragment => sql`(${raw(alias)}.expires_at IS NULL OR ${raw(alias)}.expires_at > ${now})`;

function contains(dialect: SqlRowContext['dialect'], haystack: SqlFragment, needle: string): SqlFragment {
  switch (dialect) {
    case 'sqlite':
      return sql`instr(${haystack}, ${needle}) > 0`;
    case 'postgres':
      return sql`strpos(${haystack}, ${needle}) > 0`;
    case 'mysql':
      return sql`LOCATE(${needle}, ${haystack}) > 0`;
    case 'mssql':
      return sql`CHARINDEX(${needle}, ${haystack}) > 0`;
  }
}

/** design §6.2 `<holder>`: the subject keys, or with `membership` also the live sets of `memberKeys`. */
function holder(alias: string, args: RbacAssignmentPlanArgs, now: unknown): SqlFragment {
  const key = raw(`${alias}.subject_key`);
  const own = args.subjects.length > 0 ? sql`${key} IN (${args.subjects})` : undefined;
  if (!args.membership || args.memberKeys.length === 0) return own ?? FALSE_SQL;
  const sets = sql`${key} IN (SELECT authz_m.set_key FROM ${raw(AUTHZ_SUBJECT_MEMBERSHIP_TABLE)} authz_m WHERE authz_m.member_key IN (${args.memberKeys}) AND ${live('authz_m', now)})`;
  return own ? sql`(${own} OR ${sets})` : sets;
}

const qualified = (r: RbacPlanRole): boolean => r.scopeTypes !== undefined || r.tag !== undefined || r.relation !== undefined;

/** The principals among the holder keys (wildcards and sets name nobody in particular). */
function principalsOf(args: RbacAssignmentPlanArgs): PrincipalRef[] {
  const out = new Map<string, PrincipalRef>();
  for (const key of [...args.subjects, ...args.memberKeys]) {
    const p = parsePrincipalSubjectKey(key);
    if (p) out.set(key, p);
  }
  return [...out.values()];
}

/** The row's relation holds for one of `principals`; undefined (FALSE) when the type has no such relation or no principal fits it. */
function relationSql(row: SqlRowContext, name: 'owner' | 'self', principals: readonly PrincipalRef[]): SqlFragment | undefined {
  const columns = row.relation(name);
  if (!columns) return undefined;
  const column = raw(row.rowColumn(columns.column));
  if (columns.typeColumn) {
    if (principals.length === 0) return undefined;
    const typeColumn = raw(row.rowColumn(columns.typeColumn));
    return sql`(${join(
      ' OR ',
      principals.map((p) => sql`(${typeColumn} = ${p.type} AND ${column} = ${p.id})`),
    )})`;
  }
  // Without a type column the relation names user principals only (overview, ResourceEntry.owner).
  const ids = [...new Set(principals.filter((p) => p.type === 'user').map((p) => p.id))];
  return ids.length === 0 ? undefined : sql`${column} IN (${ids})`;
}

/** The roles that count in one branch: plain ones in one IN list, qualified ones each with their conditions. */
function roleClause(alias: string, roles: readonly RbacPlanRole[], branch: 'direct' | 'ancestor' | 'global', row: SqlRowContext, principals: readonly PrincipalRef[]): SqlFragment | undefined {
  const usable = roles.filter((r) => !(branch === 'direct' && r.descendantsOnly) && (r.scopeTypes === undefined || r.scopeTypes.length > 0));
  const plain = [...new Set(usable.filter((r) => !qualified(r)).map((r) => r.role))];
  const parts: SqlFragment[] = plain.length > 0 ? [sql`${raw(alias)}.role IN (${plain})`] : [];
  for (const r of usable.filter(qualified)) {
    const conditions = [sql`${raw(alias)}.role = ${r.role}`];
    if (r.scopeTypes) conditions.push(sql`${raw(alias)}.scope_type IN (${r.scopeTypes})`);
    if (r.tag !== undefined) conditions.push(contains(row.dialect, raw(`${alias}.tags`), `,${r.tag},`));
    if (r.relation !== undefined) {
      const relation = relationSql(row, r.relation, principals);
      if (!relation) continue;
      conditions.push(relation);
    }
    parts.push(sql`(${join(' AND ', conditions)})`);
  }
  return parts.length === 0 ? undefined : sql`(${join(' OR ', parts)})`;
}

/** The deny form of design §6.2 (one sub-query); positive here, the plan's consumer negates deny terms. */
function denyShape(args: RbacAssignmentPlanArgs, row: SqlRowContext, now: unknown): SqlFragment {
  const id = raw(row.rowId);
  const roles = [...new Set(args.roles.map((r) => r.role))];
  return sql`EXISTS (SELECT 1 FROM ${raw(AUTHZ_ASSIGNMENT_TABLE)} authz_d WHERE ${holder('authz_d', args, now)} AND authz_d.role IN (${roles}) AND ${live('authz_d', now)} AND ((authz_d.scope_type = ${row.type} AND authz_d.scope_id = ${id}) OR EXISTS (SELECT 1 FROM ${raw(row.ancestorTable)} authz_a WHERE authz_a.resource_type = ${row.type} AND authz_a.resource_id = ${id} AND authz_a.ancestor_type = authz_d.scope_type AND authz_a.ancestor_id = authz_d.scope_id) OR authz_d.scope_type = ${GLOBAL_TYPE}))`;
}

/** The row matches args (lane L8 decision 6): a live assignment of one of the roles, held by the holders, at the row, an ancestor or (global) $global. */
export function rbacAssignmentSql(args: RbacAssignmentPlanArgs, row: SqlRowContext): SqlFragment {
  if (args.roles.length === 0 || (args.subjects.length === 0 && !(args.membership && args.memberKeys.length > 0))) return FALSE_SQL;
  const now = nowOf(row);
  if (args.global && args.roles.every((r) => !qualified(r) && !r.descendantsOnly)) return denyShape(args, row, now);
  const table = raw(AUTHZ_ASSIGNMENT_TABLE);
  const id = raw(row.rowId);
  const principals = principalsOf(args);
  const branches: SqlFragment[] = [];
  const direct = roleClause('authz_s', args.roles, 'direct', row, principals);
  if (direct) branches.push(sql`EXISTS (SELECT 1 FROM ${table} authz_s WHERE authz_s.scope_type = ${row.type} AND authz_s.scope_id = ${id} AND ${holder('authz_s', args, now)} AND ${live('authz_s', now)} AND ${direct})`);
  const above = roleClause('authz_s', args.roles, 'ancestor', row, principals);
  if (above) branches.push(sql`EXISTS (SELECT 1 FROM ${raw(row.ancestorTable)} authz_a JOIN ${table} authz_s ON authz_s.scope_type = authz_a.ancestor_type AND authz_s.scope_id = authz_a.ancestor_id WHERE authz_a.resource_type = ${row.type} AND authz_a.resource_id = ${id} AND ${holder('authz_s', args, now)} AND ${live('authz_s', now)} AND ${above})`);
  const global = args.global ? roleClause('authz_s', args.roles, 'global', row, principals) : undefined;
  if (global) branches.push(sql`EXISTS (SELECT 1 FROM ${table} authz_s WHERE authz_s.scope_type = ${GLOBAL_TYPE} AND ${holder('authz_s', args, now)} AND ${live('authz_s', now)} AND ${global})`);
  return branches.length === 0 ? FALSE_SQL : sql`(${join(' OR ', branches)})`;
}

@Singleton()
@Injectable(PlanTermSql)
export class RbacAssignmentSql extends PlanTermSql {
  readonly op = RBAC_ASSIGNMENT_PLAN_OP;

  toSql(args: unknown, row: SqlRowContext): SqlFragment {
    return Object.freeze(rbacAssignmentSql(parseRbacPlanArgs(args), row));
  }
}
