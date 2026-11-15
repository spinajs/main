import { sessionPrincipalsMatch } from '@spinajs/authz-orm/plan';
import type { RlsSqlContext } from '@spinajs/authz-orm/plan';

import { AUTHZ_ASSIGNMENT_TABLE } from '../stores/tables.js';
import type { RbacAssignmentPlanArgs, RbacPlanRole } from './args.js';

const GLOBAL_TYPE = '$global';

const live = (alias: string, ctx: RlsSqlContext): string => `(${alias}.expires_at IS NULL OR ${alias}.expires_at > ${ctx.now})`;

const hasTag = (alias: string, tag: string, ctx: RlsSqlContext): string => `${ctx.literal(tag)} = ANY(string_to_array(${alias}.tags, ','))`;

/**
 * Where assignment `s` counts for the row: at the row, at an ancestor, at $global; an assignment at
 * the bare type (`scope_id = ''`) covers every row of it, as scopeCovers reads it for checks.
 */
function scope(role: RbacPlanRole, global: boolean, ctx: RlsSqlContext): string {
  const type = ctx.literal(ctx.type);
  const parts: string[] = [];
  if (!role.descendantsOnly) parts.push(`(s.scope_type = ${type} AND (s.scope_id = ${ctx.id} OR s.scope_id = ''))`);
  parts.push(`EXISTS (SELECT 1 FROM ${ctx.ancestorTable} a WHERE a.resource_type = ${type} AND a.resource_id = ${ctx.id} AND a.ancestor_type = s.scope_type AND (a.ancestor_id = s.scope_id OR s.scope_id = ''))`);
  if (global) parts.push(`s.scope_type = '${GLOBAL_TYPE}'`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

/**
 * The role's tag: carried by the assignment that grants the role, or by any live assignment of the
 * principal at $global or the bare type (the principal's live tag set, as checks read requiresTag).
 */
function tag(t: string, ctx: RlsSqlContext): string {
  const held = `EXISTS (SELECT 1 FROM ${AUTHZ_ASSIGNMENT_TABLE} g WHERE g.subject_key IN (${ctx.subjectKeys}) AND ${live('g', ctx)} AND (g.scope_type = '${GLOBAL_TYPE}' OR (g.scope_type = ${ctx.literal(ctx.type)} AND g.scope_id = '')) AND ${hasTag('g', t, ctx)})`;
  return `(${hasTag('s', t, ctx)} OR ${held})`;
}

function relation(name: string, ctx: RlsSqlContext): string {
  const columns = ctx.relation(name);
  // A relation the table does not have holds for no row, as fitting() leaves its principals out in lists.
  return columns === undefined ? 'FALSE' : sessionPrincipalsMatch(ctx, columns);
}

function role(r: RbacPlanRole, global: boolean, ctx: RlsSqlContext): string {
  const parts = [`s.role = ${ctx.literal(r.role)}`];
  if (r.scopeTypes !== undefined) parts.push(r.scopeTypes.length === 0 ? 'FALSE' : `s.scope_type IN (${r.scopeTypes.map((t) => ctx.literal(t)).join(', ')})`);
  if (r.tag !== undefined) parts.push(tag(r.tag, ctx));
  parts.push(scope(r, global, ctx));
  if (r.relation !== undefined) parts.push(relation(r.relation, ctx));
  return `(${parts.join(' AND ')})`;
}

/**
 * `rbac.assignment` for a row level security policy: a live assignment of one of the roles, held by one
 * of the session's subject keys (`spina.subject_keys`, never `args.subjects`), that reaches the row.
 */
export function rbacAssignmentSql(args: RbacAssignmentPlanArgs, ctx: RlsSqlContext): string {
  if (args.roles.length === 0) return 'FALSE';
  const roles = args.roles.map((r) => role(r, args.global, ctx)).join(' OR ');
  return `EXISTS (SELECT 1 FROM ${AUTHZ_ASSIGNMENT_TABLE} s WHERE s.subject_key IN (${ctx.subjectKeys}) AND ${live('s', ctx)} AND (${roles}))`;
}
