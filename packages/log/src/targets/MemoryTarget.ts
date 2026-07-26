import { ICommonTargetOptions, ILogEntry, LogTarget } from "@spinajs/log-common";
import { Injectable, Singleton } from "@spinajs/di";

/**
 * Options for {@link MemoryTarget}.
 */
export interface IMemoryTargetOptions extends ICommonTargetOptions {
  /**
   * Max number of log entries retained in the ring buffer. Once exceeded, the
   * oldest entries are dropped. Default is 100.
   */
  limit: number;
}

/**
 * Ring-buffer target that keeps the last N log entries in memory. Lets a debug
 * / health endpoint or a crash handler read recent log context back in-process
 * ( eg. capturing all levels incl. trace ) without parsing the log file.
 *
 * Pure and browser-safe - no filesystem, no timers, no external deps.
 */
@Singleton()
@Injectable("MemoryTarget")
export class MemoryTarget extends LogTarget<IMemoryTargetOptions> {
  protected Buffer: ILogEntry[] = [];

  constructor(options: IMemoryTargetOptions) {
    super(options);

    // apply defaults over the ( already layout-merged ) options, mirroring the
    // Loki target's Object.assign approach.
    this.Options = Object.assign(
      {
        limit: 100,
      },
      this.Options
    );
  }

  public write(data: ILogEntry): void {
    if (!this.Options.enabled) {
      return;
    }

    this.Buffer.push(data);

    // drop oldest while over the cap. splice ( rather than a single shift )
    // handles a limit lowered at runtime, not just push-by-one growth.
    if (this.Buffer.length > this.Options.limit) {
      this.Buffer.splice(0, this.Buffer.length - this.Options.limit);
    }
  }

  /**
   * Returns a shallow copy of the retained entries ( oldest first ) so callers
   * cannot mutate the ring buffer.
   */
  public getRecords(): ILogEntry[] {
    return [...this.Buffer];
  }

  /**
   * Empties the buffer.
   */
  public clear(): void {
    this.Buffer = [];
  }
}
