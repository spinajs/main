import { PlanTermCompiler } from '@spinajs/authz-orm/plan';
import type { PlanRow } from '@spinajs/authz-orm/plan';
import { Injectable, Singleton } from '@spinajs/di';
import { outer } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { REBAC_TUPLES_PLAN_OP, parseRebacPlanArgs } from '../model/filter.js';
import type { RebacPlanExpr } from '../model/filter.js';
import { AUTHZ_REBAC_TUPLE_TABLE } from '../stores/db.js';

type Where = IWhereBuilder<unknown>;

/** EXISTS a tuple of the row (namespace, object_id) with the relation and one of the subject keys; it uses the authz_rebac_tuple_object index. */
function applyExpr(e: RebacPlanExpr, where: Where, row: PlanRow): void {
  if ('tuples' in e) {
    const { relation, subjects } = e.tuples;
    if (subjects.length === 0) {
      where.where(false);
      return;
    }
    const t = row.from(AUTHZ_REBAC_TUPLE_TABLE, 'authz_rt');
    t.where('namespace', row.type).whereColumn('object_id', '=', outer(row.id)).where('relation', relation).whereIn('subject_key', [...subjects]);
    where.whereExist(t);
    return;
  }
  if ('any' in e) {
    where.where(function () {
      for (const c of e.any) {
        this.orWhere(function () {
          applyExpr(c, this, row);
        });
      }
    });
    return;
  }
  where.where(function () {
    for (const c of e.all) {
      this.where(function () {
        applyExpr(c, this, row);
      });
    }
  });
}

/** `rebac.tuples` in SQL: an EXISTS sub-query on authz_rebac_tuple per leaf, OR and AND groups for any and all. */
@Singleton()
@Injectable(PlanTermCompiler)
export class RebacTuplesTerm extends PlanTermCompiler {
  readonly op = REBAC_TUPLES_PLAN_OP;

  apply(args: unknown, where: IWhereBuilder<unknown>, row: PlanRow): void {
    applyExpr(parseRebacPlanArgs(args), where, row);
  }
}
