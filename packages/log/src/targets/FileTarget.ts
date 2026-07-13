import { EOL } from "os";
import { posix } from "path";
import { format } from "@spinajs/configuration";
import { InvalidOption } from "@spinajs/exceptions";
import { DI, IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import { fs } from "@spinajs/fs";
import { IFileTargetOptions, Logger, Log, ILogEntry, LogTarget } from "@spinajs/log-common";

import { LogArchiveService } from "../archive/LogArchiveService.js";
import { ILogArchiveContext } from "../archive/context.js";

/**
 * Default fs provider used for the active log file when `fs` option is omitted.
 * Registered automatically by the log package ( base path = process.cwd() ).
 */
const DEFAULT_FS = "fs-log-default";

/**
 * Writes log messages to a file through the @spinajs/fs abstraction.
 *
 * Messages are buffered in memory and flushed as a single batched append,
 * either when the buffer reaches `maxBufferSize` or on a periodic flush tick.
 * Rotation / archiving / retention is delegated to {@link LogArchiveService}.
 *
 * A single async write-lock ( a promise-chain mutex ) serializes every flush
 * and every rotation, so a rename can never race an in-flight append.
 *
 * PerInstanceCheck: multiple file targets can point at different files, but two
 * targets with the same name share one writer.
 */
@PerInstanceCheck()
@Injectable("FileTarget")
export class FileTarget extends LogTarget<IFileTargetOptions> implements IInstanceCheck {
  @Logger("LogFileTarget")
  protected Log: Log;

  /**
   * fs provider holding the active log file.
   */
  protected Fs: fs;

  /**
   * fs provider archives are moved to ( defaults to `Fs` ).
   */
  protected ArchiveFs: fs;

  /**
   * Directory ( relative to ArchiveFs ) archives are stored in.
   */
  protected ArchiveDir = "";

  protected ArchiveService: LogArchiveService;
  protected Context: ILogArchiveContext;

  /**
   * In-memory buffer of formatted, not-yet-written messages.
   */
  protected Buffer: string[] = [];

  protected FlushTimer: NodeJS.Timeout | null = null;

  /**
   * Async initialization ( fs resolution + mkdir + archive start ). write()
   * and flush() await this so nothing touches the fs before it is ready.
   */
  protected Ready: Promise<void>;

  /**
   * Promise-chain mutex tail. Every critical section ( flush, rotation ) chains
   * onto this so they run strictly one at a time.
   */
  protected WriteLock: Promise<unknown> = Promise.resolve();

  protected Disposed = false;

  __checkInstance__(creationOptions: IFileTargetOptions[]): boolean {
    return this.Options.name === creationOptions[0].name;
  }

  public resolve(): void {
    this.Options.options = Object.assign(
      {
        compress: false,
        maxSize: 1024 * 1024,
        maxArchiveFiles: 5,
        maxBufferSize: 100,
        archiveInterval: 60,
        archiveStrategy: "SizeLogArchiveStrategy",
        retentionStrategies: ["CountLogRetentionStrategy"],
      },
      this.Options.options
    );

    if (!this.Options.options.path) {
      throw new InvalidOption(`FileTarget ${this.Options.name} requires a 'path' option`);
    }

    // start async init - fs resolution and dir creation cannot run in a sync
    // SyncService.resolve, so writes buffer until Ready settles
    this.Ready = this.init();
    this.Ready.catch((err) => {
      this.HasError = true;
      this.Error = err;
      this.Log.error(err as Error, `Cannot initialize file target ${this.Options.name}`);
    });

    // periodic flush so a partially filled buffer is not held indefinitely
    this.FlushTimer = setInterval(() => {
      void this.flush();
    }, 1000);

    super.resolve();
  }

  /**
   * Resolves fs providers, ensures directories exist, builds the archive
   * context and starts the archive service.
   */
  protected async init(): Promise<void> {
    const o = this.Options.options;

    this.Fs = DI.resolve<fs>("__file_provider__", [o.fs ?? DEFAULT_FS]);
    this.ArchiveFs = o.archiveFs ? DI.resolve<fs>("__file_provider__", [o.archiveFs]) : this.Fs;

    // path is relative to the fs provider base path; ensure its directory exists
    const logDir = posix.dirname(this.activePath());
    if (logDir && logDir !== ".") {
      await this.Fs.mkdir(logDir);
    }

    // archivePath ( when set ) is a directory relative to the archive fs; when
    // not set, archives live in the same directory as the active log
    this.ArchiveDir = o.archivePath ? this.normalize(format(null, o.archivePath)) : logDir === "." ? "" : logDir;
    if (this.ArchiveDir) {
      await this.ArchiveFs.mkdir(this.ArchiveDir);
    }

    this.Context = {
      fs: this.Fs,
      archiveFs: this.ArchiveFs,
      activePath: this.activePath(),
      archiveDir: this.ArchiveDir,
      options: o,
      logger: this.Log,
      rotate: () => this.ArchiveService.rotate(this.Context),
      withWriteLock: <T>(fn: () => Promise<T>) => this.withWriteLock(fn),
    };

    this.ArchiveService = await DI.resolve(LogArchiveService);
    await this.ArchiveService.start(this.Context);
  }

  public async write(data: ILogEntry): Promise<void> {
    if (!this.Options.enabled || this.Disposed) {
      return;
    }

    const entry = format(data.Variables, this.Options.layout);
    this.Buffer.push(entry);

    if (this.Buffer.length >= this.Options.options.maxBufferSize) {
      await this.flush();
    }
  }

  /**
   * Flushes the current buffer as one batched append, guarded by the
   * write-lock. On failure the batch is PREPENDED back so nothing is lost.
   */
  protected async flush(): Promise<void> {
    if (this.Buffer.length === 0) {
      return;
    }

    await this.Ready.catch(() => {
      /* init failed - error already recorded, skip flushing */
    });

    if (!this.Fs) {
      return;
    }

    await this.withWriteLock(async () => {
      if (this.Buffer.length === 0) {
        return;
      }

      // snapshot the batch and clear the shared buffer so concurrent write()s
      // append to a fresh buffer while this batch is in flight
      const batch = this.Buffer;
      this.Buffer = [];

      const path = this.activePath();

      try {
        await this.Fs.append(path, batch.join(EOL) + EOL);
        this.HasError = false;
        this.Error = null;
      } catch (err) {
        this.HasError = true;
        this.Error = err;
        this.Log.error(err as Error, `Cannot write log messages to file target at path ${path}`);

        // restore the batch in front of anything queued meanwhile - never drop
        this.Buffer = [...batch, ...this.Buffer];
      }
    });
  }

  public async dispose(): Promise<void> {
    this.Disposed = true;

    if (this.FlushTimer) {
      clearInterval(this.FlushTimer);
      this.FlushTimer = null;
    }

    // final flush of anything buffered
    await this.flush();

    this.ArchiveService?.stop();
  }

  /**
   * Runs `fn` under the shared write-lock. Flush and rotation both go through
   * here, so a rename can never overlap an append.
   */
  protected withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.WriteLock.then(() => fn());
    // keep the chain alive on failure so the lock never deadlocks
    this.WriteLock = run.catch(() => {});
    return run;
  }

  /**
   * Active log path relative to the fs provider base path. Recomputed each call
   * so dynamic ( eg. date-based ) paths work.
   */
  protected activePath(): string {
    const p = format({ logger: this.Options.name }, this.Options.options.path);
    return this.normalize(p);
  }

  /**
   * Normalizes a configured path to forward slashes and strips a leading
   * separator. Paths are interpreted relative to the fs provider base path -
   * the provider itself sandboxes and resolves them, so we only canonicalize
   * separators here.
   */
  protected normalize(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\/+/, "");
  }
}
