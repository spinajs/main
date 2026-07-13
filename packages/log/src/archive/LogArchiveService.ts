import { AsyncService, Class, DI, Injectable, NewInstance, ResolveException } from "@spinajs/di";
import { Logger, Log } from "@spinajs/log-common";
import { DateTime } from "luxon";
import { parse, posix } from "path";
import { LogArchiveStrategy } from "./archive-strategy.js";
import { LogRetentionStrategy } from "./retention-strategy.js";
import { ILogArchiveContext } from "./context.js";
import { ARCHIVE_PREFIX, archivePath } from "./strategies/util.js";

/**
 * Orchestrates rotation + retention for a single file log target.
 *
 * It owns nothing schedule-wise itself: it resolves ONE rotation strategy
 * ( `archiveStrategy` ) and a LIST of retention strategies
 * ( `retentionStrategies` ) by class name from DI, delegates start / stop to the
 * rotation strategy, and provides the shared `rotate()` routine every rotation
 * ( interval, cron or manual ) funnels through.
 *
 * `@NewInstance()` - each file target gets its own service ( per-target
 * scheduling and strategy state ).
 */
@Injectable()
@NewInstance()
export class LogArchiveService extends AsyncService {
  @Logger("LogFileTarget")
  protected Logger: Log;

  protected ArchiveStrategy: LogArchiveStrategy;
  protected RetentionStrategies: LogRetentionStrategy[] = [];

  /**
   * Resolves the configured rotation + retention strategies by class name.
   * Follows the fs temp-provider mechanism: look the class up in the DI
   * registry by name, then resolve an instance.
   */
  public async resolve(): Promise<void> {
    await super.resolve();
  }

  /**
   * Wires strategies for the given context and starts the rotation schedule.
   */
  public async start(ctx: ILogArchiveContext): Promise<void> {
    // archiveStrategy / retentionStrategies are populated from the logger.file
    // config defaults ( see FileTarget.resolve ), so no inline fallback here -
    // the config is the single source of truth for what runs.
    this.ArchiveStrategy = this.resolveStrategy(LogArchiveStrategy, ctx.options.archiveStrategy as string);

    const retentionNames = ctx.options.retentionStrategies ?? [];
    this.RetentionStrategies = retentionNames.map((n) => this.resolveStrategy(LogRetentionStrategy, n));

    this.ArchiveStrategy.start(ctx);
  }

  /**
   * Stops the rotation schedule. Safe to call multiple times.
   */
  public stop(): void {
    this.ArchiveStrategy?.stop();
  }

  /**
   * Single rotation routine, shared by every scheduling strategy:
   *
   *  1. acquire the target write-lock so no append runs while we rename,
   *  2. rename the active file to a sequenced archive name in the archive dir,
   *  3. compress ( zip into archiveFs, drop the raw file ) OR move cross-fs,
   *  4. run every retention strategy in order,
   *  5. release the lock ( always, even on failure ).
   *
   * The whole routine is guarded so a failed rotation neither crashes the
   * scheduler nor leaves the lock held.
   */
  public async rotate(ctx: ILogArchiveContext): Promise<void> {
    await ctx.withWriteLock(async () => {
      // nothing written yet - nothing to rotate
      if (!(await ctx.fs.exists(ctx.activePath))) {
        return;
      }

      const archived = await this.moveToArchive(ctx);

      if (ctx.options.compress) {
        await this.compress(ctx, archived);
      }
    });

    // retention runs OUTSIDE the write-lock - it only touches archive files,
    // never the active log, so it must not block appends.
    for (const strategy of this.RetentionStrategies) {
      await strategy.safePrune(ctx);
    }
  }

  /**
   * Renames the active log file into the archive dir under a unique
   * `archived_<name>_<seq><ext>` name. When `archiveFs` differs from `fs` the
   * file is first renamed within `fs` then moved across.
   *
   * Returns the archive path relative to `archiveFs`.
   */
  protected async moveToArchive(ctx: ILogArchiveContext): Promise<string> {
    const { name, ext } = parse(posix.basename(ctx.activePath.replace(/\\/g, "/")));
    const seq = await this.nextSequence(ctx, name, ext);
    const archiveName = `${ARCHIVE_PREFIX}${name}_${seq}${ext}`;
    const archiveRel = archivePath(ctx, archiveName);

    if (ctx.archiveFs === ctx.fs) {
      await ctx.fs.rename(ctx.activePath, archiveRel);
      return archiveRel;
    }

    // cross-fs: rename to a temp name inside `fs`, then move into archiveFs
    const stagingRel = `${ARCHIVE_PREFIX}${name}_${seq}${ext}`;
    await ctx.fs.rename(ctx.activePath, stagingRel);
    await ctx.fs.move(stagingRel, archiveRel, ctx.archiveFs);
    return archiveRel;
  }

  /**
   * Zips `archived` into `archiveFs` and removes the raw archived file, so the
   * archive dir only ever holds the compressed copy.
   */
  protected async compress(ctx: ILogArchiveContext, archived: string): Promise<void> {
    const zipRel = `${archived}.zip`;

    // zip() honors a non-temp dstFs / dstFile - output lands directly in archiveFs
    await ctx.archiveFs.zip(archived, ctx.archiveFs, zipRel);
    await ctx.archiveFs.rm(archived);

    this.Logger.trace(`Compressed archive ${archived} -> ${zipRel}`);
  }

  /**
   * Next archive sequence number for a given base name. Uses existing archive
   * file names first, falling back to a timestamp so two rotations in the same
   * tick never collide.
   */
  protected async nextSequence(ctx: ILogArchiveContext, name: string, ext: string): Promise<number> {
    let existing: string[] = [];
    try {
      existing = await ctx.archiveFs.list(ctx.archiveDir || "/");
    } catch {
      existing = [];
    }

    const prefix = `${ARCHIVE_PREFIX}${name}_`;
    // prefix is escaped via escapeRegExp before interpolation
    // eslint-disable-next-line security/detect-non-literal-regexp
    const seqReg = new RegExp(`^${escapeRegExp(prefix)}(\\d+)`);

    let max = 0;
    for (const f of existing) {
      const m = seqReg.exec(f);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) {
          max = n;
        }
      }
    }

    const next = max + 1;

    // guard against a name clash ( eg. same-second cron + size rotation ) by
    // appending a millisecond timestamp only when the computed name already exists
    const candidate = archivePath(ctx, `${ARCHIVE_PREFIX}${name}_${next}${ext}`);
    if (await ctx.archiveFs.exists(candidate)) {
      return DateTime.now().toMillis();
    }

    return next;
  }

  /**
   * Resolves a strategy instance by class name, mirroring the fs temp-provider
   * mechanism: look the class up in the DI registry by name, then resolve an
   * instance ( `@NewInstance()` gives a fresh per-target instance ).
   */
  protected resolveStrategy<T>(base: Class<T>, className: string): T {
    const types = DI.RootContainer.Registry.getTypes(base);
    const type = types.find((x) => (x as { name: string }).name === className);

    if (!type) {
      const baseName = (base as { name: string }).name;
      throw new ResolveException(
        `Log archive strategy ${className} ( ${baseName} ) not registered, make sure it is imported and registered in DI container`
      );
    }

    // strategies are plain ( non-async ) services, so resolve is synchronous
    return DI.resolve(type as Class<T>) as T;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
