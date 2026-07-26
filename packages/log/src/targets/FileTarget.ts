import { EOL } from "os";
import { posix } from "path";
import { Configuration, format } from "@spinajs/configuration";
import { InvalidOption } from "@spinajs/exceptions";
import { DI, IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import { fs } from "@spinajs/fs";
import { IFileTargetOptions, Logger, Log, ILogEntry, LogTarget, BatchQueue } from "@spinajs/log-common";

import { LogArchiveService } from "../archive/LogArchiveService.js";
import { ILogArchiveContext } from "../archive/context.js";
import { LOG_FILE_DEFAULTS } from "../config/log.js";

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
   * Buffered-batch queue owning accumulation, the flush tick and the hard queue
   * cap. It delegates the actual batched append to {@link append} via onFlush.
   */
  protected Queue: BatchQueue<string>;

  /**
   * Set true when the queue drops overflow, so the drop warning is emitted ONCE
   * per overflow episode and reset when a batch appends successfully.
   */
  protected Overflowed = false;

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
    // Defaults come from the shipped `logger.file` config ( discoverable and
    // user-overridable like every other spinajs package ). LOG_FILE_DEFAULTS is
    // the same object the config ships and is used as a last-resort fallback for
    // environments where the config file was not discovered ( eg. some tests ).
    // Merge order ( lowest to highest ): constant < config < per-target options.
    const cfg = DI.get(Configuration);
    const fileDefaults = cfg ? cfg.get<Partial<IFileTargetOptions["options"]>>("logger.file", {}) : {};
    this.Options.options = Object.assign({}, LOG_FILE_DEFAULTS, fileDefaults, this.Options.options);

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

    // BatchQueue owns accumulation, the periodic flush tick ( unref'd, so a
    // pending flush never keeps the process alive ) and the hard queue cap. The
    // batched append itself runs in append() under the write-lock.
    this.Queue = new BatchQueue<string>({
      maxBatch: this.Options.options.maxBufferSize,
      maxQueue: this.Options.options.maxQueueSize,
      flushIntervalMs: this.Options.options.flushInterval ?? LOG_FILE_DEFAULTS.flushInterval,
      onFlush: (batch) => this.append(batch),
      onOverflow: (droppedItems) => {
        // droppedItems here are already-formatted STRINGS, so we cannot
        // reconstruct the original ILogEntry to route via OnDropped. File
        // overflow stays warn-only ( count from droppedItems.length ). The
        // drop-hook ( D ) targets the network-primary -> file-fallback case,
        // not File-as-primary drops.
        if (!this.Overflowed) {
          this.Overflowed = true;
          this.Log.warn(`File target ${this.Options.name} buffer exceeded ${this.Options.options.maxQueueSize} messages, dropped ${droppedItems.length} oldest buffered messages.`);
        }
      },
    });

    super.resolve();
  }

  /**
   * Resolves fs providers, ensures directories exist, builds the archive
   * context and starts the archive service.
   */
  protected async init(): Promise<void> {
    const o = this.Options.options;

    // o.fs is always populated from LOG_FILE_DEFAULTS ( see resolve() )
    this.Fs = DI.resolve<fs>("__file_provider__", [o.fs]);
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

    const entry = this.formatEntry(data);
    // enqueue awaits the batched append when maxBatch ( = maxBufferSize ) is
    // reached, preserving the old "await flush when full" back-pressure
    await this.Queue.enqueue(entry);
  }

  /**
   * Builds the single line appended for one entry. Overridable so subclasses can
   * change ONLY the per-entry serialization while reusing the whole FileTarget
   * pipeline ( batched append, write-lock, rotation, retention, zip ). The base
   * renders the configured string `layout`.
   */
  protected formatEntry(data: ILogEntry): string {
    return format(data.Variables, this.Options.layout);
  }

  /**
   * Flushes any buffered messages. Delegates to the queue's forceFlush so a
   * caller ( eg. dispose or a test ) can await the drain.
   */
  protected async flush(): Promise<void> {
    await this.Queue.forceFlush();
  }

  public forceFlush(): Promise<void> {
    return this.Queue ? this.Queue.forceFlush() : Promise.resolve();
  }

  /**
   * Appends one batch as a single write, guarded by the write-lock ( the SAME
   * lock rotation uses, so a rename can never race an append ). On failure the
   * batch is requeued at the FRONT so nothing is lost ( never-drop, bounded by
   * maxQueue ). This ALWAYS resolves ( never rejects ) so queue.shutdown() -
   * driven by dispose() - never rejects.
   */
  protected async append(batch: string[]): Promise<void> {
    await this.Ready.catch(() => {
      /* init failed - error already recorded, skip appending */
    });

    if (!this.Fs) {
      // init failed / fs unavailable - keep the batch for a later retry
      this.Queue.requeueFront(batch);
      return;
    }

    await this.withWriteLock(async () => {
      const path = this.activePath();

      try {
        await this.Fs.append(path, batch.join(EOL) + EOL);
        this.HasError = false;
        this.Error = null;
        // batch appended successfully - allow the next overflow episode to warn again
        this.Overflowed = false;
      } catch (err) {
        this.HasError = true;
        this.Error = err;
        this.Log.error(err as Error, `Cannot write log messages to file target at path ${path}`);

        // restore the batch in front of anything queued meanwhile - never drop.
        // the queue caps at maxQueue, dropping the oldest if the sink stays down.
        this.Queue.requeueFront(batch);
      }
    });
  }

  public async dispose(): Promise<void> {
    this.Disposed = true;

    // stops the flush timer and performs a final flush of anything buffered
    await this.Queue.shutdown();

    this.ArchiveService?.stop();
  }

  /**
   * Runs `fn` under the shared write-lock. Flush and rotation both go through
   * here, so a rename can never overlap an append.
   */
  protected withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.WriteLock.then(() => fn());
    // keep the chain alive on failure so the lock never deadlocks
    this.WriteLock = run.catch(() => undefined);
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
