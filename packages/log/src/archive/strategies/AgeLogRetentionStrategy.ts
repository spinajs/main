import { Injectable, NewInstance } from "@spinajs/di";
import { DateTime } from "luxon";
import { LogRetentionStrategy } from "../retention-strategy.js";
import { ILogArchiveContext } from "../context.js";
import { listArchives } from "./util.js";

/**
 * Default archive age limit in seconds ( 7 days ) when `maxAge` is not set.
 */
const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60;

/**
 * Deletes archives older than `maxAge` seconds. Age is taken from the archive
 * modification time.
 */
@Injectable(LogRetentionStrategy)
@NewInstance()
export class AgeLogRetentionStrategy extends LogRetentionStrategy {
  public async prune(ctx: ILogArchiveContext): Promise<void> {
    const maxAge = ctx.options.maxAge ?? DEFAULT_MAX_AGE;
    const now = DateTime.now();

    const archives = await listArchives(ctx);

    for (const a of archives) {
      const ts = a.stat.ModifiedTime;
      if (!ts || !ts.isValid) {
        continue;
      }

      if (now.diff(ts, "seconds").seconds > maxAge) {
        try {
          this.Logger.trace(`Deleting archive ${a.path} ( older than ${maxAge}s )`);
          await ctx.archiveFs.rm(a.path);
        } catch (err) {
          this.Logger.warn(`Cannot delete archive ${a.path}: ${(err as Error).message}`);
        }
      }
    }
  }
}
