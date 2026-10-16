import { Injectable, NewInstance } from "@spinajs/di";
import { DateTime } from "luxon";
import { LogRetentionStrategy } from "../retention-strategy.js";
import { ILogArchiveContext } from "../context.js";
import { listArchives } from "./util.js";

/**
 * Deletes archives older than `maxAge` seconds ( from the logger.file config
 * defaults ). Age is taken from the archive modification time.
 */
@Injectable(LogRetentionStrategy)
@NewInstance()
export class AgeLogRetentionStrategy extends LogRetentionStrategy {
  public async prune(ctx: ILogArchiveContext): Promise<void> {
    // maxAge is always populated from the config defaults ( see logger.file )
    const maxAge = ctx.options.maxAge as number;
    const now = DateTime.now();

    const archives = await listArchives(ctx);

    for (const a of archives) {
      const ts = a.stat.ModifiedTime;
      if (!ts || !ts.isValid) {
        continue;
      }

      if (now.diff(ts, "seconds").seconds > maxAge) {
        try {
          this.Logger.trace({ archivePath: a.path, maxAge }, "Deleting archive ${archivePath} ( older than ${maxAge}s )");
          await ctx.archiveFs.rm(a.path);
        } catch (err) {
          this.Logger.warn({ error: err, archivePath: a.path }, "Cannot delete archive ${archivePath}");
        }
      }
    }
  }
}
