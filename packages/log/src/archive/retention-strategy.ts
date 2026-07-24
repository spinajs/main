import { Logger, Log } from "@spinajs/log-common";
import { ILogArchiveContext } from "./context.js";

/**
 * Retention policy for archived log files. Decides WHICH archives are deleted
 * after a rotation ( eg. keep newest N, drop older than maxAge ).
 *
 * Retention strategies are composable - a file target applies a LIST of them in
 * sequence, so count + age can be combined. Each concrete strategy is
 * `@NewInstance()` to keep per-target state isolated, mirroring the fs cleanup
 * strategies.
 */
export abstract class LogRetentionStrategy {
  @Logger("LogFileTarget")
  protected Logger: Log;

  /**
   * Removes archives from `ctx.archiveDir` according to the strategy policy.
   *
   * @param ctx archive context of the file target
   */
  public abstract prune(ctx: ILogArchiveContext): Promise<void>;

  /**
   * Single prune guarded against errors so one failing retention strategy never
   * aborts the rest of the retention list or the rotation routine.
   */
  public async safePrune(ctx: ILogArchiveContext): Promise<void> {
    try {
      await this.prune(ctx);
    } catch (err) {
      this.Logger.warn(`Log retention for target ${ctx.options.path} failed: ${(err as Error).message}`);
    }
  }
}
