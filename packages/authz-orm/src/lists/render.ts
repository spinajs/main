import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { AccessPlan, DenyReason, PlanTerm, ResourceRef } from '@spinajs/authz';
import { outer } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import type { PlanRow, PlanTermCompiler } from '../plan/index.js';
import { planTermCompilers } from './terms.js';

type Where = IWhereBuilder<unknown>;

export type PlanFilter = { readonly kind: 'all' } | { readonly kind: 'none'; readonly reason: DenyReason } | { readonly kind: 'where'; readonly apply: (where: Where) => void };

/** One term in a group of its own, so its top-level OR stays inside. */
function term(where: Where, t: PlanTerm, row: PlanRow, compilers: ReadonlyMap<string, PlanTermCompiler>): void {
  const compiler = compilers.get(t?.op);
  if (!compiler) throw new AuthzConfigError(`authz-orm: no PlanTermCompiler applies op ${JSON.stringify(t?.op)}; register one with @Injectable(PlanTermCompiler)`);
  where.orWhere(function () {
    compiler.apply(t.args, this, row);
    // An empty group compiles to no condition at all, which would keep every row.
    if (this.Statements.length === 0) throw new AuthzConfigError(`authz-orm: ${compiler.constructor.name}.apply() for op ${JSON.stringify(t.op)} added no condition; a term that matches no row adds where(false)`);
  });
}

function anyOf(where: Where, terms: readonly PlanTerm[], row: PlanRow, compilers: ReadonlyMap<string, PlanTermCompiler>): void {
  if (terms.length === 0) {
    where.where(false);
    return;
  }
  for (const t of terms) term(where, t, row, compilers);
}

/** The row is one of `refs`, or descends from one (authz_resource_ancestor). */
export function applyWithin(where: Where, refs: readonly ResourceRef[], row: PlanRow): void {
  if (refs.some((r) => r.type === GLOBAL.type || (r.type === row.type && (r.id === undefined || r.id === null)))) {
    where.where(true);
    return;
  }
  const exact = refs.filter((r) => r.id !== undefined && r.id !== null);
  const selfIds = [...new Set(exact.filter((r) => r.type === row.type).map((r) => String(r.id)))];
  const types = [...new Set(refs.filter((r) => r.id === undefined || r.id === null).map((r) => r.type))];
  if (exact.length === 0 && types.length === 0) {
    where.where(false);
    return;
  }
  const above = row.from(row.ancestorTable, 'authz_w');
  above
    .where('resource_type', row.type)
    .whereColumn('resource_id', '=', outer(row.id))
    .where(function () {
      for (const r of exact) {
        this.orWhere(function () {
          this.where('ancestor_type', r.type).where('ancestor_id', String(r.id));
        });
      }
      if (types.length > 0) {
        this.orWhere(function () {
          this.whereIn('ancestor_type', types);
        });
      }
    });
  where.where(function () {
    if (selfIds.length > 0) {
      this.orWhere(function () {
        this.whereIn(row.id, selfIds);
      });
    }
    this.orWhere(function () {
      this.whereExist(above);
    });
  });
}

/** Design §6.2 over opaque terms: (permit OR …) AND NOT (deny OR …) AND within. */
export function planFilter(plan: AccessPlan, row: PlanRow, compilers: ReadonlyMap<string, PlanTermCompiler> = planTermCompilers()): PlanFilter {
  if (plan.kind === 'none') return { kind: 'none', reason: plan.reason };
  if (plan.kind !== 'filter') throw new AuthzConfigError(`authz-orm: unknown access plan kind ${JSON.stringify((plan as { kind?: unknown }).kind)}`);
  const { permit, deny, within } = plan;
  if (permit === 'all' && deny.length === 0 && within === undefined) return { kind: 'all' };
  return {
    kind: 'where',
    apply: (where) => {
      if (permit !== 'all') {
        where.where(function () {
          anyOf(this, permit, row, compilers);
        });
      }
      if (deny.length > 0) {
        where.whereNot(function () {
          anyOf(this, deny, row, compilers);
        });
      }
      if (within !== undefined) {
        where.where(function () {
          applyWithin(this, within, row);
        });
      }
    },
  };
}
