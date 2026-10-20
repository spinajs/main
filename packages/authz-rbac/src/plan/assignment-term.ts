import type { PrincipalRef } from '@spinajs/authz';
import { PlanTermCompiler } from '@spinajs/authz-orm/plan';
import type { PlanRow } from '@spinajs/authz-orm/plan';
import { Injectable, Singleton } from '@spinajs/di';
import { Wrapper, outer } from '@spinajs/orm';
import type { ISelectQueryBuilder, IWhereBuilder } from '@spinajs/orm';

import { parsePrincipalSubjectKey } from '../model/sets/keys.js';
import { AUTHZ_ASSIGNMENT_TABLE } from '../stores/tables.js';
import { RBAC_ASSIGNMENT_PLAN_OP, parseRbacPlanArgs } from './args.js';
import type { RbacAssignmentPlanArgs, RbacPlanRole } from './args.js';

type Where = IWhereBuilder<unknown>;
type Branch = 'direct' | 'ancestor' | 'global';

const GLOBAL_TYPE = '$global';

const qualified = (r: RbacPlanRole): boolean => r.scopeTypes !== undefined || r.tag !== undefined || r.relation !== undefined;

/** Not expired, by the database's clock. */
function live(q: Where, row: PlanRow): void {
  const now = row.now();
  q.where(function () {
    this.whereNull('expires_at').orWhere('expires_at', '>', now);
  });
}

/** The principals among the holder keys (wildcards and sets name nobody in particular). */
function principalsOf(args: RbacAssignmentPlanArgs): PrincipalRef[] {
  const out = new Map<string, PrincipalRef>();
  for (const key of args.subjects) {
    const p = parsePrincipalSubjectKey(key);
    if (p) out.set(key, p);
  }
  return [...out.values()];
}

/** The principals the row's relation column can name: any with a type column, else users only. */
function fitting(row: PlanRow, name: string, principals: readonly PrincipalRef[]): PrincipalRef[] {
  const columns = row.relation(name);
  if (!columns) return [];
  return columns.typeColumn !== undefined ? [...principals] : principals.filter((p) => p.type === 'user');
}

/** The row's relation column names one of `principals` (non-empty, from fitting()). */
function relation(where: Where, row: PlanRow, name: string, principals: readonly PrincipalRef[]): void {
  const { column, typeColumn } = row.relation(name)!;
  if (typeColumn === undefined) {
    where.whereIn(Wrapper.Text(column), [...new Set(principals.map((p) => p.id))]);
    return;
  }
  where.where(function () {
    for (const p of principals) {
      this.orWhere(function () {
        this.where(typeColumn, p.type).where(Wrapper.Text(column), '=', p.id);
      });
    }
  });
}

/** The roles of one sub-query: plain ones in one IN list, qualified ones each with their scope types and tag. */
function roles(q: Where, plain: readonly string[], qualifiedRoles: readonly RbacPlanRole[]): void {
  q.where(function () {
    if (plain.length > 0) {
      this.orWhere(function () {
        this.whereIn('role', [...plain]);
      });
    }
    for (const r of qualifiedRoles) {
      this.orWhere(function () {
        this.where('role', r.role);
        if (r.scopeTypes) this.whereIn('scope_type', [...r.scopeTypes]);
        if (r.tag !== undefined) this.whereInSet('tags', [r.tag]);
      });
    }
  });
}

/** Live assignments held by the holders at the row (direct), at one of its ancestors, or at $global. */
function assignments(row: PlanRow, args: RbacAssignmentPlanArgs, branch: Branch, withRoles: (q: Where) => void): ISelectQueryBuilder<unknown> {
  const s = row.from(AUTHZ_ASSIGNMENT_TABLE, 'authz_s');
  if (branch === 'direct') s.where('scope_type', row.type).whereColumn('scope_id', '=', outer(row.id));
  else if (branch === 'global') s.where('scope_type', GLOBAL_TYPE);
  else s.whereColumn('scope_type', '=', outer('ancestor_type')).whereColumn('scope_id', '=', outer('ancestor_id'));
  s.whereIn('subject_key', [...args.subjects]);
  live(s, row);
  withRoles(s);
  if (branch !== 'ancestor') return s;
  const a = row.from(row.ancestorTable, 'authz_a');
  a.where('resource_type', row.type).whereColumn('resource_id', '=', outer(row.id)).whereExist(s);
  return a;
}

/** The deny form of design §6.2: one sub-query over the assignments, matching at the row, an ancestor or $global. */
function denyShape(where: Where, row: PlanRow, args: RbacAssignmentPlanArgs): void {
  const above = row.from(row.ancestorTable, 'authz_a');
  above
    .where('resource_type', row.type)
    .whereColumn('resource_id', '=', outer(row.id, 2))
    .whereColumn('ancestor_type', '=', outer('scope_type'))
    .whereColumn('ancestor_id', '=', outer('scope_id'));
  const d = row.from(AUTHZ_ASSIGNMENT_TABLE, 'authz_d');
  d.whereIn('subject_key', [...args.subjects]).whereIn('role', [...new Set(args.roles.map((r) => r.role))]);
  live(d, row);
  d.where(function () {
    this.where(function () {
      this.where('scope_type', row.type).whereColumn('scope_id', '=', outer(row.id));
    })
      .orWhere(function () {
        this.whereExist(above);
      })
      .orWhere('scope_type', GLOBAL_TYPE);
  });
  where.whereExist(d);
}

/** The row matches args (lane L8 decision 6): a live assignment of one of the roles, held by the holders, at the row, an ancestor or (global) $global. */
export function applyRbacAssignment(args: RbacAssignmentPlanArgs, where: Where, row: PlanRow): void {
  if (args.roles.length === 0 || args.subjects.length === 0) {
    where.where(false);
    return;
  }
  if (args.global && args.roles.every((r) => !qualified(r) && !r.descendantsOnly)) {
    denyShape(where, row, args);
    return;
  }
  const principals = principalsOf(args);
  let matched = false;
  const branches: Branch[] = args.global ? ['direct', 'ancestor', 'global'] : ['direct', 'ancestor'];
  for (const branch of branches) {
    const usable = args.roles.filter((r) => !(branch === 'direct' && r.descendantsOnly) && (r.scopeTypes === undefined || r.scopeTypes.length > 0));
    const plain = [...new Set(usable.filter((r) => !qualified(r)).map((r) => r.role))];
    const scoped = usable.filter((r) => qualified(r) && r.relation === undefined);
    if (plain.length > 0 || scoped.length > 0) {
      matched = true;
      where.orWhere(function () {
        this.whereExist(assignments(row, args, branch, (q) => roles(q, plain, scoped)));
      });
    }
    // A relation reads only the row, so it stands next to the sub-query: one EXISTS per relation, ANDed with it.
    for (const name of new Set(usable.flatMap((r) => (r.relation === undefined ? [] : [r.relation])))) {
      const related = usable.filter((r) => r.relation === name);
      const holders = fitting(row, name, principals);
      if (related.length === 0 || holders.length === 0) continue;
      matched = true;
      where.orWhere(function () {
        this.whereExist(assignments(row, args, branch, (q) => roles(q, [], related)));
        relation(this, row, name, holders);
      });
    }
  }
  if (!matched) where.where(false);
}

@Singleton()
@Injectable(PlanTermCompiler)
export class RbacAssignmentTerm extends PlanTermCompiler {
  readonly op = RBAC_ASSIGNMENT_PLAN_OP;

  apply(args: unknown, where: IWhereBuilder<unknown>, row: PlanRow): void {
    applyRbacAssignment(parseRbacPlanArgs(args), where, row);
  }
}
