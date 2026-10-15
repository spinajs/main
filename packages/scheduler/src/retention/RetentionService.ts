import { Class, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { createQuery, DeleteQueryBuilder, ModelBase } from '@spinajs/orm';
import { TERMINAL_RUN_STATUSES } from '../contract.js';
import { resolveSchedulerConfig, SchedulerConfig } from '../interfaces.js';
import { ErrorGroupModel } from '../models/ErrorGroupModel.js';
import { RunAttemptModel } from '../models/RunAttemptModel.js';
import { RunLogModel } from '../models/RunLogModel.js';
import { RunModel } from '../models/RunModel.js';
import { RunStepModel } from '../models/RunStepModel.js';
import { parseDuration } from '../time/duration.js';

export interface PurgeResult {
  runs: number;
  logs: number;
  errors: number;
}

/**
 * The capped journal kinds (R3). `status`, `step-*` and `error` rows stay as long as their run, so a
 * run that is still listed can still be replayed to its final status.
 */
const PURGED_LOG_KINDS = ['log', 'message', 'progress'];

/** `Model.destroy()` refuses a DELETE that is not keyed by primary keys; these are filtered by other columns. */
function deleteFrom(model: Class<ModelBase>): DeleteQueryBuilder<unknown> {
  return createQuery(model, DeleteQueryBuilder).query;
}

@Singleton()
@Injectable()
export class RetentionService {
  @Config('scheduler', { defaultValue: {} })
  protected RawConfig: Partial<SchedulerConfig>;

  protected batchSize = 500;

  /**
   * Deletes terminal runs finished before `retention.runs` (with their steps, attempts and journal
   * rows), `log` / `message` / `progress` journal rows older than `retention.logs`, and `resolved`
   * error groups last seen before `retention.errors`. `now` is database time.
   */
  public async purge(now: number): Promise<PurgeResult> {
    const { retention } = resolveSchedulerConfig(this.RawConfig);
    const runsBefore = now - parseDuration(retention.runs, 'scheduler.retention.runs');
    const logsBefore = now - parseDuration(retention.logs, 'scheduler.retention.logs');
    const errorsBefore = now - parseDuration(retention.errors, 'scheduler.retention.errors');

    let runs = 0;
    for (;;) {
      const batch = await RunModel.query()
        .whereIn('Status', [...TERMINAL_RUN_STATUSES])
        .where('FinishedAt', '<', runsBefore)
        .take(this.batchSize);
      if (!batch.length) break;
      const ids = batch.map((r) => r.Id);
      await deleteFrom(RunStepModel).whereIn('RunId', ids);
      await deleteFrom(RunAttemptModel).whereIn('RunId', ids);
      await deleteFrom(RunLogModel).whereIn('RunId', ids);
      const deleted = Number((await RunModel.destroy(ids)).RowsAffected);
      runs += deleted;
      // another replica purged this batch first; it carries on with the rest
      if (deleted === 0) break;
    }

    const logs = Number(
      (await deleteFrom(RunLogModel).whereIn('Kind', PURGED_LOG_KINDS).where('Ts', '<', logsBefore)).RowsAffected,
    );
    const errors = Number(
      (await deleteFrom(ErrorGroupModel).where('Status', 'resolved').where('LastSeen', '<', errorsBefore)).RowsAffected,
    );
    return { runs, logs, errors };
  }
}
