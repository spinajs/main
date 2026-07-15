import { Autoinject, Container, DI, SyncService } from "@spinajs/di";
import _ from "lodash";
import { format } from "./format.js";
import { applySerializers } from "./serializers.js";

export * from "./serializers.js";
export * from "./filters/whenRepeated.js";

import type { IWhenRepeatedOptions } from "./filters/whenRepeated.js";

export enum LogLevel {
  Security = 999,

  Fatal = 6,

  Error = 5,

  Warn = 4,

  Success = 3,

  Info = 2,

  Debug = 1,

  Trace = 0,
}

export const StrToLogLevel = {
  trace: LogLevel.Trace,
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  success: LogLevel.Success,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
  fatal: LogLevel.Fatal,
  security: LogLevel.Security,
};

export const LogLevelStrings = {
  [LogLevel.Debug]: "debug",
  [LogLevel.Error]: "error",
  [LogLevel.Fatal]: "fatal",
  [LogLevel.Info]: "info",
  [LogLevel.Security]: "security",
  [LogLevel.Success]: "success",
  [LogLevel.Trace]: "trace",
  [LogLevel.Warn]: "warn",
};

export interface ILogRule {
  name: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "security" | "success";
  target: string | string[];
}

export interface ITargetsOption {
  name: string;
  type: string;
  options?: ICommonTargetOptions;
}

export interface ILogOptions {
  targets: ITargetsOption[];
  rules: ILogRule[];
  variables?: Record<string, unknown>;

  /**
   * Opt-in dedup filter that collapses identical repeated log entries. When set,
   * every logger gets its OWN WhenRepeatedFilter instance ( independent state ).
   * Default off.
   */
  whenRepeated?: IWhenRepeatedOptions;
}

export interface ICommonTargetOptions {
  /**
   * Message layout. You can use variables
   *
   * Default message layout is: datetime level message (logger)
   */
  layout: string;

  /**
   * Target name
   */
  name: string;

  /**
   * Target type
   */
  type: string;

  /**
   * Is logger enabled
   */
  enabled: boolean;
}

export interface IColoredConsoleTargetOptions extends ICommonTargetOptions {
  /**
   * Color theme for console message. Best leave it for default.
   */
  theme: {
    security: string | string[];
    fatal: string | string[];
    error: string | string[];
    warn: string | string[];
    success: string | string[];
    info: string | string[];
    debug: string | string[];
    trace: string | string[];
  };
}

export interface IFileTargetOptions extends ICommonTargetOptions {
  options: {
    /**
     * path where the active log is stored ( relative to the `fs` provider base
     * path ). Variables are allowed to build the path eg. date / time etc.
     */
    path: string;

    /**
     * Directory ( relative to the `archiveFs` provider base path ) rotated /
     * archived files are stored in. Variables are allowed.
     *
     * When not set archives are stored in the same directory as the active log.
     */
    archivePath: string;

    /**
     * Name of the registered `@spinajs/fs` provider that stores the ACTIVE log
     * file. Defaults to `fs-log-default` ( registered automatically, base path
     * = process.cwd() ).
     */
    fs?: string;

    /**
     * Name of the registered `@spinajs/fs` provider archives are moved to.
     * Defaults to the same provider as `fs`.
     */
    archiveFs?: string;

    /**
     * Class name of the LogArchiveStrategy that decides WHEN to rotate.
     * Default is `SizeLogArchiveStrategy` ( interval size check ). Use
     * `CronLogArchiveStrategy` together with `rotate` for scheduled rotation.
     */
    archiveStrategy?: string;

    /**
     * List of LogRetentionStrategy class names applied in order after each
     * rotation. Compose eg. count + age. Default is [`CountLogRetentionStrategy`].
     */
    retentionStrategies?: string[];

    /**
     * Maximum active log file size in bytes. When exceeded the file is rotated
     * to the archive by `SizeLogArchiveStrategy`. Default is 1mb.
     */
    maxSize: number;

    /**
     * Compress ( zip ) the archived file when moved to the archive.
     *
     * Default is false.
     */
    compress: boolean;

    /**
     * Cron expression used by `CronLogArchiveStrategy` to rotate the log
     * ( 6-field with seconds supported, eg. '0 0 1 * * *' = 1am daily ).
     * Required when that strategy is selected.
     *
     * Default is not set.
     */
    rotate: string;

    /**
     * Max internal message buffer size before writing to file. Higher means
     * fewer disk writes. Defaults to 100 messages.
     */
    maxBufferSize: number;

    /**
     * Hard cap on the number of buffered messages held in memory. When exceeded
     * ( eg. the fs sink is down and appends keep failing so the batch is
     * prepended back ) the OLDEST buffered messages are dropped so memory stays
     * bounded. Defaults to 100000.
     */
    maxQueueSize: number;

    /**
     * How many archive files to keep before deletion, used by
     * `CountLogRetentionStrategy`. Oldest by modification time are deleted.
     * Default is 5.
     */
    maxArchiveFiles: number;

    /**
     * Max archive age in seconds, used by `AgeLogRetentionStrategy`. Archives
     * older than this are deleted. Default is 7 days.
     */
    maxAge?: number;

    /**
     * Interval in seconds at which `SizeLogArchiveStrategy` checks whether the
     * active log needs rotating. Default is 60 seconds.
     */
    archiveInterval: number;

    /**
     * Periodic flush tick in milliseconds. A partially filled buffer is flushed
     * at least this often so messages are not held indefinitely. Default 1000ms.
     */
    flushInterval?: number;
  };
}

export interface ILogStaticVariables {
  error: Error | undefined;
  level: string;
  logger: string;
  message: string;
}

export interface ILogVariable {
  [key: string]: unknown | (() => unknown);
}

export interface ILogEntry {
  Level: LogLevel;
  Variables: LogVariables;
}

export abstract class LogTarget<T extends ICommonTargetOptions> extends SyncService {
  public HasError = false;
  public Error: Error | null | unknown = null;
  public Options: T;

  constructor(options: T) {
    super();

    if (options) {
      this.Options = _.merge(
        _.merge(this.Options, {
          enabled: true,
          layout: "${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})",
        }),
        options
      );
    } else {
      this.Options = {
        enabled: true,
        layout: "${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})",
      } as T;
    }
  }

  public abstract write(data: ILogEntry): void;
}

export interface ILogTargetDesc {
  instance: LogTarget<ICommonTargetOptions>;
  options?: ITargetsOption;
  rule: ILogRule;
}

export function createLogMessageObject(err: Error | string, message: string | any[], level: LogLevel, logger: string, variables: any, ...args: any[]): ILogEntry {
  const sMsg = err instanceof Error || !err ? (message as string) : err;
  const tMsg = args.length !== 0 ? format(sMsg, ...args) : sMsg;
  const lName = logger ?? message;

  const theVars = {
    error: err instanceof Error ? err : undefined,
    level: LogLevelStrings[`${level}`].toUpperCase(),
    logger: lName,
    message: tMsg,
    ...variables,
  };

  applySerializers(theVars);

  return {
    Level: level,
    Variables: theVars,
  };
}

export abstract class Log extends SyncService {
  public static Loggers: Map<string, Log> = new Map();
  public static InternalLoggers: Map<string, Log> = new Map();

  public Timers: Map<string, Date> = new Map<string, Date>();
  protected Targets: ILogTargetDesc[];
  public Name: string;

  protected static AttachedToExitEvents = false;

  protected Options: ILogOptions;

  protected Rules: ILogRule[];

  @Autoinject()
  protected Container: Container;

  protected Variables: Record<string, any> = {};

  public static clearLoggers() {
    return Promise.all([...Log.Loggers.values()].map((l) => l.dispose()))
      .then(() => {
        Log.Loggers.clear();
      })
      .then(() => {
        return [...Log.InternalLoggers.values()].map((l) => l.dispose());
      });
  }

  public addVariable(name: string, value: unknown) {
    this.Variables[`${name}`] = value;
  }

  public timeStart(name: string): void {
    if (this.Timers.has(name)) {
      return;
    }

    this.Timers.set(name, new Date());
  }

  public timeEnd(name: string): number {

    const timer = this.Timers.get(name);
    if (!timer) {
      return 0;
    }

    const cTime = new Date();
    const diff = cTime.getTime() - timer.getTime();

    this.Timers.delete(name);

    return diff;
  }

  public child(name: string, variables?: LogVariables): Log {
    return DI.resolve(Log, [
      `${this.Name}.${name}`,
      {
        ...this.Variables,
        ...variables,
      },
      this,
    ]);
  }

  public abstract trace(message: string, ...args: any[]): void;
  public abstract trace(err: Error, message: string, ...args: any[]): void;
  public abstract trace(fields: object, message?: string, ...args: any[]): void;
  public abstract trace(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract debug(message: string, ...args: any[]): void;
  public abstract debug(err: Error, message: string, ...args: any[]): void;
  public abstract debug(fields: object, message?: string, ...args: any[]): void;
  public abstract debug(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract info(message: string, ...args: any[]): void;
  public abstract info(err: Error, message: string, ...args: any[]): void;
  public abstract info(fields: object, message?: string, ...args: any[]): void;
  public abstract info(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract warn(message: string, ...args: any[]): void;
  public abstract warn(err: Error, message: string, ...args: any[]): void;
  public abstract warn(fields: object, message?: string, ...args: any[]): void;
  public abstract warn(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract error(message: string, ...args: any[]): void;
  public abstract error(err: Error, message: string, ...args: any[]): void;
  public abstract error(fields: object, message?: string, ...args: any[]): void;
  public abstract error(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract fatal(message: string, ...args: any[]): void;
  public abstract fatal(err: Error, message: string, ...args: any[]): void;
  public abstract fatal(fields: object, message?: string, ...args: any[]): void;
  public abstract fatal(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract security(message: string, ...args: any[]): void;
  public abstract security(err: Error, message: string, ...args: any[]): void;
  public abstract security(fields: object, message?: string, ...args: any[]): void;
  public abstract security(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract success(message: string, ...args: any[]): void;
  public abstract success(err: Error, message: string, ...args: any[]): void;
  public abstract success(fields: object, message?: string, ...args: any[]): void;
  public abstract success(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]>;
}

/**
 * Creates ( if not exists ) new logger instance with given name and optional variables
 * @param name - name of logger
 * @param variables - optional log variables
 */
export function Logger(name: string, variables?: Record<string, unknown>) {
  return (target: any, key: string): any => {
    let logger: Log;

    // property getter
    const getter = () => {
      if (!logger) {
        const allLoggers = DI.get(Array.ofType(Log));
        const found = allLoggers!.find((l) => l.Name === name);

        if (found) {
          logger = found;
        } else {
          logger = DI.resolve(Log, [name, variables]);
        }
      }
      return logger;
    };

    // Create new property with getter and setter
    Object.defineProperty(target, key, {
      get: getter,
      enumerable: false,
      configurable: false,
    });
  };
}

export type LogVariables = ILogStaticVariables & ILogVariable;

