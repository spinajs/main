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
