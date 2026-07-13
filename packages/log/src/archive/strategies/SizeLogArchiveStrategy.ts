import { Injectable, NewInstance } from "@spinajs/di";
import { LogArchiveStrategy } from "../archive-strategy.js";
import { ILogArchiveContext } from "../context.js";

/**
 * Rotates the active log file when its size exceeds `maxSize`, checked every
 * `archiveInterval` seconds ( both resolved from the logger.file config
 * defaults, overridable per target ).
 */
@Injectable(LogArchiveStrategy)
@NewInstance()
export class SizeLogArchiveStrategy extends LogArchiveStrategy {
  protected timer: NodeJS.Timeout | null = null;

  public start(ctx: ILogArchiveContext): void {
    // never leak a previous timer on repeated start
    this.stop();

    const interval = ctx.options.archiveInterval * 1000;

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
