import { Configuration } from '@spinajs/configuration';
import { Autoinject, DI } from '@spinajs/di';
import { Schedule, ScheduledTask } from '@spinajs/scheduler';
import type { RunContext, ScheduleOptions } from '@spinajs/scheduler';

import { UploadSweeper } from './sweeper.js';
import type { SweepResult } from './sweeper.js';

export const UPLOAD_SWEEP_SCHEDULE = 'upload.sweep';

/** The schema default of upload.sweeper.every, for a read before the Configuration resolved. */
const DEFAULT_EVERY = '15m';

const SWEEP_SCHEDULE: ScheduleOptions = {
  runOn: 'leader',
  overlap: 'skip',
  // A getter: the decorator runs at import, before the configuration is loaded; the registry reads it at resolve.
  get every(): string {
    const configuration = DI.get(Configuration) as Configuration | undefined;
    return configuration?.get<string>('upload.sweeper.every') ?? DEFAULT_EVERY;
  },
};

/** Spec §9 as a scheduler task, one replica per occurrence; a `scheduler.schedules` entry of the same name overrides it. */
@Schedule(UPLOAD_SWEEP_SCHEDULE, SWEEP_SCHEDULE)
export class UploadSweepTask extends ScheduledTask {
  @Autoinject(UploadSweeper)
  protected Sweeper: UploadSweeper;

  public async execute(ctx: RunContext): Promise<SweepResult> {
    const result = await this.Sweeper.sweep({ signal: ctx.signal });
    // The scheduler persists ctx.result only for successful runs, so a failed run carries the counts in its message.
    if (result.errors > 0) throw new Error(`upload sweep: ${result.errors} item(s) failed: ${JSON.stringify(result)}`);
    ctx.result(result);
    return result;
  }
}
