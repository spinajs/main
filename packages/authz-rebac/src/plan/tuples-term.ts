import { PlanTermCompiler } from '@spinajs/authz-orm/plan';
import type { PlanRow } from '@spinajs/authz-orm/plan';
import { Injectable, Singleton } from '@spinajs/di';
import type { IWhereBuilder } from '@spinajs/orm';

import { REBAC_TUPLES_PLAN_OP } from '../model/filter.js';

/** `rebac.tuples` in SQL: an EXISTS sub-query on authz_rebac_tuple per leaf, OR and AND groups for any and all. */
@Singleton()
@Injectable(PlanTermCompiler)
export class RebacTuplesTerm extends PlanTermCompiler {
  readonly op = REBAC_TUPLES_PLAN_OP;

  apply(_args: unknown, _where: IWhereBuilder<unknown>, _row: PlanRow): void {
    throw new Error('not implemented: RebacTuplesTerm.apply');
  }
}
