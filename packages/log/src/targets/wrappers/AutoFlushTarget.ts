import { ICommonTargetOptions, ILogEntry, ITargetsOption, LogTarget, StrToLogLevel } from "@spinajs/log-common";
import { DI, Injectable, Singleton } from "@spinajs/di";

/**
 * Options for {@link AutoFlushTarget}.
 */
export interface IAutoFlushTargetOptions extends ICommonTargetOptions {
  options: {
    /**
     * Inline child target this wrapper decorates. Resolved through DI exactly
     * like a top-level target.
     */
    target: ITargetsOption;

    /**
     * Severity ( inclusive ) at or above which the inner target is force-flushed
     * right after the entry is written, so a crash-level event is never left
     * buffered. Default `"error"`.
     */
    flushLevel?: string;
  };
}

/**
 * Wraps ONE inner target and force-flushes it whenever an entry at or above
 * `flushLevel` ( default error ) is written, so a high-severity / crash-level
 * event is never left sitting in a buffer. The inner target is declared inline
 * and owned by this wrapper ( resolve / flush / dispose ).
 *
 * Pure / browser-safe - just delegates to its child.
 */
@Singleton()
@Injectable("AutoFlushTarget")
export class AutoFlushTarget extends LogTarget<IAutoFlushTargetOptions> {
  protected Inner: LogTarget<ICommonTargetOptions>;

  /** Resolved numeric severity threshold at/above which we force-flush. */
  protected Threshold: number;

  public resolve(): void {
    this.Inner = DI.resolve<LogTarget<ICommonTargetOptions>>(this.Options.options.target.type, [this.Options.options.target]);
    this.Threshold = StrToLogLevel[(this.Options.options.flushLevel ?? "error") as keyof typeof StrToLogLevel];

    super.resolve();
  }

  public async write(entry: ILogEntry): Promise<void> {
    if (!this.Options.enabled) {
      return;
    }

    // wrap in Promise.resolve because some targets' write is sync / void.
    await Promise.resolve(this.Inner.write(entry));

    if (entry.Level >= this.Threshold) {
      await this.Inner.forceFlush();
    }
  }

  public forceFlush(): Promise<void> {
    return this.Inner.forceFlush();
  }

  public async dispose(): Promise<void> {
    await (this.Inner as any).dispose?.();
  }
}
