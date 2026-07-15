import { ILogEntry, ILogFilterOptions, LogFilter, LogLevel, StrToLogLevel } from "@spinajs/log-common";
import { Injectable } from "@spinajs/di";

type LevelName = keyof typeof StrToLogLevel;

/**
 * Options for {@link LevelFilter}.
 */
export interface ILevelFilterOptions extends ILogFilterOptions {
  /** Lowest level to keep ( inclusive ). Entries below are dropped. */
  min?: LevelName;
  /** Highest level to keep ( inclusive ). Entries above are dropped. */
  max?: LevelName;
}

/**
 * Level-window filter. Keeps an entry only when its numeric {@link LogLevel} is
 * within `[min, max]` ( both inclusive, both optional ), otherwise drops it.
 * Useful for routing eg. only warn..error to a given target via a filter.
 */
@Injectable("LevelFilter")
export class LevelFilter extends LogFilter {
  protected min: LogLevel;
  protected max: LogLevel;

  constructor(options?: ILevelFilterOptions) {
    super(options);
    this.min = options?.min !== undefined ? StrToLogLevel[options.min] : LogLevel.Trace;
    this.max = options?.max !== undefined ? StrToLogLevel[options.max] : LogLevel.Security;
  }

  public apply(entry: ILogEntry): ILogEntry | null {
    if (entry.Level < this.min || entry.Level > this.max) {
      return null;
    }
    return entry;
  }
}
