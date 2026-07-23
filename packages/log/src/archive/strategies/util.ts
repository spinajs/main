import { IStat } from "@spinajs/fs";
import { posix } from "path";
import { ILogArchiveContext } from "../context.js";

/**
 * Prefix every archived file name gets. Only files under `archiveDir` starting
 * with this prefix are considered archives ( so the active log dir, when it is
 * the same directory as the archive dir, is not touched ).
 */
export const ARCHIVE_PREFIX = "archived_";

export interface IArchiveEntry {
  /**
   * Path of the archive relative to `archiveFs` base path.
   */
  path: string;
  stat: IStat;
}

/**
 * Joins archive dir + file name with forward slashes. fs providers resolve
 * paths against their base path and normalize separators, so a posix join keeps
 * behaviour identical across platforms.
 */
export function archivePath(ctx: ILogArchiveContext, name: string): string {
  return ctx.archiveDir ? posix.join(ctx.archiveDir, name) : name;
}

/**
 * Lists archive files in `ctx.archiveDir` on `ctx.archiveFs`, sorted ascending
 * by modification time ( oldest first, newest last ). Only files carrying the
 * archive prefix are returned; directories and unrelated files are ignored.
 */
export async function listArchives(ctx: ILogArchiveContext): Promise<IArchiveEntry[]> {
  let names: string[];
  try {
    names = await ctx.archiveFs.list(ctx.archiveDir || "/");
  } catch {
    // archive dir may not exist yet ( nothing rotated )
    return [];
  }

  const entries: IArchiveEntry[] = [];

  for (const name of names) {
    if (!name.startsWith(ARCHIVE_PREFIX)) {
      continue;
    }

    const p = archivePath(ctx, name);
    try {
      const stat = await ctx.archiveFs.stat(p);
      if (stat.IsDirectory) {
        continue;
      }
      entries.push({ path: p, stat });
    } catch {
      // stat can fail on a file removed concurrently - skip it
    }
  }

  entries.sort((a, b) => {
    const at = a.stat.ModifiedTime?.toMillis() ?? 0;
    const bt = b.stat.ModifiedTime?.toMillis() ?? 0;
    return at - bt;
  });

  return entries;
}
