import type { IWhereBuilder } from '@spinajs/orm';

import { PlanTermCompiler } from '../../src/plan/index.js';
import type { PlanRow } from '../../src/plan/index.js';

/** A test op: the row's `flag` column equals `args.flag`. */
export class FlagTerm extends PlanTermCompiler {
  readonly op = 'test.flag';

  apply(args: unknown, where: IWhereBuilder<unknown>, _row: PlanRow): void {
    where.where('flag', (args as { flag: string }).flag);
  }
}

/** A compiler that breaks its contract: it adds no condition. */
export class SilentTerm extends PlanTermCompiler {
  readonly op = 'test.silent';

  apply(): void {}
}

/** Adds only empty groups, which compile to nothing: as silent as SilentTerm. */
export class EmptyGroupTerm extends PlanTermCompiler {
  readonly op = 'test.empty-group';

  apply(_args: unknown, where: IWhereBuilder<unknown>): void {
    where.where(function () {
      this.orWhere(function () {});
    });
    where.whereNot(function () {});
  }
}
