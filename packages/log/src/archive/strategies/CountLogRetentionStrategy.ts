import { Injectable, NewInstance } from "@spinajs/di";
import { LogRetentionStrategy } from "../retention-strategy.js";
import { ILogArchiveContext } from "../context.js";
import { listArchives } from "./util.js";

/**
 * Default number of archives to keep when `maxArchiveFiles` is not configured.
 */
const DEFAULT_MAX_ARCHIVE_FILES = 5;

/**
 * Keeps the newest N archives ( `maxArchiveFiles` ) and deletes the oldest,
 * ordered by modification time.
 */
@Injectable(LogRetentionStrategy)
@NewInstance()
export class CountLogRetentionStrategy extends LogRetentionStrategy {
  public async prune(ctx: ILogArchiveContext): Promise<void> {
    const keep = ctx.options.maxArchiveFiles ?? DEFAULT_MAX_ARCHIVE_FILES;

    // newest last ( ascending by ModifiedTime )
    const archives = await listArchives(ctx);

    if (archives.length <= keep) {
      return;
    }

    const toDelete = archives.slice(0, archives.length - keep);

    for (const a of toDelete) {
      try {
        this.Logger.trace(`Deleting archive ${a.path} ( over count limit ${keep} )`);
        await ctx.archiveFs.rm(a.path);
      } catch (err) {
        this.Logger.warn(`Cannot delete archive ${a.path}: ${(err as Error).message}`);
      }
    }
  }
}
