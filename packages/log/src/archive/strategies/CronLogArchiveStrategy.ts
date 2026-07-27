import { Injectable, NewInstance } from "@spinajs/di";
import { InvalidOption } from "@spinajs/exceptions";
import { CronJob } from "cron";
import { LogArchiveStrategy } from "../archive-strategy.js";
import { ILogArchiveContext } from "../context.js";

/**
 * Rotates the active log file on a cron schedule taken from the `rotate`
 * option ( 6-field with seconds supported, eg. '0 0 1 * * *' = 1am daily ).
 * The expression is required - creation fails without it, like fs
 * CronTempCleanupStrategy.
 */
@Injectable(LogArchiveStrategy)
@NewInstance()
export class CronLogArchiveStrategy extends LogArchiveStrategy {
  protected cronJob: CronJob | null = null;

  public start(ctx: ILogArchiveContext): void {
    if (!ctx.options.rotate) {
      throw new InvalidOption(
        `Log target ${ctx.options.path} uses CronLogArchiveStrategy but 'rotate' cron expression is not set`
      );
    }

    this.stop();

    // CronJob ctor throws on invalid expression - wrap for a clearer error
    try {
      this.cronJob = new CronJob(
        ctx.options.rotate,
        () => {
          void this.triggerRotation(ctx);
        },
        null,
        true
      );
    } catch (err) {
      throw new InvalidOption(
        `Log target ${ctx.options.path} has invalid rotate cron expression '${ctx.options.rotate}': ${(err as Error).message}`
      );
    }
  }

  public stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }
}
