import { Logger, Log } from "@spinajs/log-common";
import { ILogArchiveContext } from "./context.js";

/**
 * Rotation policy for a file log target. Decides WHEN the active log file is
 * rotated ( moved to the archive ) and owns its own schedule - the scheduling
 * mechanism ( interval, cron, ... ) is strategy specific and implemented in
 * `start` / `stop`.
 *
 * Mirrors the shape of fs `TempCleanupStrategy`: strategies hold per-target
 * scheduling state, so implementations MUST be registered with `@NewInstance()`
 * - otherwise a single instance would be shared between all file targets.
 */
export abstract class LogArchiveStrategy {
  @Logger("LogFileTarget")
  protected Logger: Log;

  /**
   * Starts scheduled rotation. How rotations are scheduled is up to the
   * strategy.
   *
   * @param ctx archive context of the file target
   */
  public abstract start(ctx: ILogArchiveContext): void;

  /**
   * Stops scheduled rotation. Safe to call multiple times.
   */
  public abstract stop(): void;

  /**
   * Single rotation trigger guarded against errors - a failed rotation ( disk
   * full, remote backend down, ... ) must never crash the scheduler tick.
   */
  protected async triggerRotation(ctx: ILogArchiveContext): Promise<void> {
    try {
      await ctx.rotate();
    } catch (err) {
      this.Logger.warn(`Log rotation for target ${ctx.options.path} failed: ${(err as Error).message}`);
    }
  }
}
