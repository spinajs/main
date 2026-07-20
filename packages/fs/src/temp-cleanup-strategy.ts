import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import { CronJob } from 'cron';
import { DateTime } from 'luxon';
import { fs, IFsTempOptions } from './interfaces.js';

/**
 * Default file age for temp files in seconds
 */
const DEFAULT_FILE_AGE = 60 * 60;

/**
 * Default cleanup interval in milliseconds
 */
const DEFAULT_CLEANUP_INTERVAL = 10 * 60 * 1000;

/**
 * Cleanup policy for temporary filesystems. Implement and register
 * to customize which files are considered stale and how they are removed,
 * then select it via `cleanupStrategy` option of fsTemp provider.
 *
 * Strategy also owns its schedule - scheduling mechanism ( interval, cron, ... )
 * is strategy specific and implemented in `start` / `stop`.
 *
 * Strategies hold scheduling state per temp filesystem, so implementations
 * must be registered with `@NewInstance()` - otherwise a single instance
 * would be shared between all temp filesystems.
 */
export abstract class TempCleanupStrategy {
  @Logger('fs')
  protected Logger: Log;

  /**
   * Performs single cleanup sweep on given filesystem.
   *
   * @param fs backend filesystem holding temp files
   * @param options temp fs configuration ( maxFileAge etc. )
   */
  public abstract cleanup(fs: fs, options: IFsTempOptions): Promise<void>;

  /**
   * Starts scheduled cleanup - how sweeps are scheduled is up to the strategy.
   *
   * @param fs backend filesystem holding temp files
   * @param options temp fs configuration
   */
  public abstract start(fs: fs, options: IFsTempOptions): void;

  /**
   * Stops scheduled cleanup. Safe to call multiple times.
   */
  public abstract stop(): void;

  /**
   * Single sweep guarded against errors - remote backends can fail
   * ( network etc. ), scheduler tick must never crash.
   */
  protected async safeCleanup(fs: fs, options: IFsTempOptions): Promise<void> {
    try {
      await this.cleanup(fs, options);
    } catch (err) {
      this.Logger.warn(`Cleanup of temporary files system ${options.name} failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Default cleanup - deletes first level files older than `maxFileAge` seconds,
 * checked every `cleanupInterval` milliseconds.
 *
 * File age is taken from CreationTime when valid, otherwise from ModifiedTime -
 * remote backends often lack creation time ( s3 reports epoch, ftp reports none ).
 * Files with no usable timestamp are skipped. It does not check files recursively
 * in subdirectories.
 */
@Injectable(TempCleanupStrategy)
@NewInstance()
export class MaxAgeTempCleanupStrategy extends TempCleanupStrategy {
  /**
   * timer instance used by interval-based scheduling
   */
  protected cleanupTimer: NodeJS.Timeout | null = null;

  public start(fs: fs, options: IFsTempOptions): void {
    // never leak a previous timer on repeated start
    this.stop();

    this.cleanupTimer = setInterval(() => {
      void this.safeCleanup(fs, options);
    }, options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL);
  }

  public stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  public async cleanup(fs: fs, options: IFsTempOptions): Promise<void> {
    const files = await fs.list('/');
    const now = DateTime.now();
    const maxFileAge = options.maxFileAge ?? DEFAULT_FILE_AGE;

    // s3 fills missing times with DateTime.min() - treat epoch-or-older as "no data"
    const valid = (t?: DateTime) => !!t && t.isValid && t.toMillis() > 0;

    for (const f of files) {
      // per-file guard - one failing stat/rm must not abort whole sweep
      try {
        const stat = await fs.stat(f);
        const ts = valid(stat.CreationTime) ? stat.CreationTime : stat.ModifiedTime;

        if (!valid(ts)) {
          continue;
        }

        if (now.diff(ts!, 'seconds').seconds > maxFileAge) {
          this.Logger.trace(
            `Temp file at path ${f} is older than ${maxFileAge} seconds, ( CreatedAt: ${ts!.toFormat(
              'dd/MM/yyyy HH:mm:ss',
            )} ), deleting...`,
          );

          await fs.rm(f);
        }
      } catch (err) {
        this.Logger.warn(`Cleanup of temp file ${f} on fs ${fs.Name} failed: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Same sweep as MaxAgeTempCleanupStrategy ( `maxFileAge` still applies ),
 * but scheduled by cron expression from `cleanupCronExpression` option
 * instead of fixed interval. Expression is required - creation fails without it.
 */
@Injectable(TempCleanupStrategy)
@NewInstance()
export class CronTempCleanupStrategy extends MaxAgeTempCleanupStrategy {
  protected cronJob: CronJob | null = null;

  public start(fs: fs, options: IFsTempOptions): void {
    if (!options.cleanupCronExpression) {
      throw new InvalidOption(
        `Temp filesystem ${options.name} uses CronTempCleanupStrategy but 'cleanupCronExpression' option is not set`,
      );
    }

    if (options.cleanupInterval) {
      this.Logger.warn(
        `Temp filesystem ${options.name} sets 'cleanupInterval' but CronTempCleanupStrategy ignores it, schedule is driven by 'cleanupCronExpression'`,
      );
    }

    this.stop();

    // CronJob ctor throws on invalid expression - wrap for a clearer error
    try {
      this.cronJob = new CronJob(
        options.cleanupCronExpression,
        () => {
          void this.safeCleanup(fs, options);
        },
        null,
        true,
      );
    } catch (err) {
      throw new InvalidOption(
        `Temp filesystem ${options.name} has invalid cron expression '${options.cleanupCronExpression}': ${
          (err as Error).message
        }`,
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
