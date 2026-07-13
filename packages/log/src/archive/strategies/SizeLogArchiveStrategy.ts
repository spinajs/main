import { Injectable, NewInstance } from "@spinajs/di";
import { LogArchiveStrategy } from "../archive-strategy.js";
import { ILogArchiveContext } from "../context.js";

/**
 * Default rotation interval in seconds. The active log size is checked this
 * often, and the file is rotated once it exceeds `maxSize`.
 */
const DEFAULT_ARCHIVE_INTERVAL = 60;

/**
 * Rotates the active log file when its size exceeds `maxSize`, checked on a
 * fixed interval ( `archiveInterval` seconds, default 60s ).
 */
@Injectable(LogArchiveStrategy)
@NewInstance()
export class SizeLogArchiveStrategy extends LogArchiveStrategy {
  protected timer: NodeJS.Timeout | null = null;

  public start(ctx: ILogArchiveContext): void {
    // never leak a previous timer on repeated start
    this.stop();

    const interval = (ctx.options.archiveInterval ?? DEFAULT_ARCHIVE_INTERVAL) * 1000;

    this.timer = setInterval(() => {
      void this.check(ctx);
    }, interval);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Rotates only when the active file exists AND is over the size limit. A
   * missing active file ( nothing written yet ) is not an error.
   */
  protected async check(ctx: ILogArchiveContext): Promise<void> {
    try {
      if (!(await ctx.fs.exists(ctx.activePath))) {
        return;
      }

      const stat = await ctx.fs.stat(ctx.activePath);
      const maxSize = ctx.options.maxSize;

      const size = stat.Size ?? 0;
      if (size > maxSize) {
        this.Logger.trace(`Active log ${ctx.activePath} size ${size} exceeds ${maxSize}, rotating`);
        await this.triggerRotation(ctx);
      }
    } catch (err) {
      this.Logger.warn(`Size check for log target ${ctx.activePath} failed: ${(err as Error).message}`);
    }
  }
}
