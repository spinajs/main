import { Autoinject, Container, DI, SyncService } from "@spinajs/di";
import _ from "lodash";
import * as util from "util";

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
     * path whre log is stored. It is allowed to use variables to create path eg. date / time etc.
     */
    path: string;

    /**
     * Archive path for logs eg. when size is exceeded. Is is allowed to use variables eg. date / time etc.
     *
     * Default is none. When not set archive files are stored in same folder as logs.
     */
    archivePath: string;

    /**
     * Maximum log file size, if exceeded it is moved to archive, and new log file is created
     *
     * Default is 1mb
     */
    maxSize: number;

    /**
     * Should compress log file when moved to archive
     *
     * Default is false
     */
    compress: boolean;

    /**
     * Should rotate log file eg. new  file every new day.
     * You should use cron like definition eg. at 1am every day: 0 1 * * *
     * When rotate event occurs, old file is moved to archive, and new one is created
     *
     * Default is not set
     */
    rotate: string;

    /**
     * Max internal message buffer size before writting to file
     * If bigger the number - less writes to disk.
     *
     * Set it big when logging very frequently to avoid disk writes
     * Defaults to 100 messages
     */
    maxBufferSize: number;

    /**
     * How mutch archive files should be preserved before deletion. Default is 0
     * Eg. to store max 5 archive files, set it to 5. Oldest by modification time are deleted.
     */
    maxArchiveFiles: number;

    /**
     * Log archive interval at whitch process should check if log files need archiving, in seconds.
     * Default is 3 minutes
     */
    archiveInterval: number;
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
          layout: "${datetime} ${level} ${message} Exception: ${error:message} (${logger})",
        }),
        options
      );
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
  const tMsg = args.length !== 0 ? util.format(sMsg, ...args) : sMsg;
  const lName = logger ?? message;

  return {
    Level: level,
    Variables: {
      error: err instanceof Error ? err : undefined,
      level: LogLevelStrings[`${level}`].toUpperCase(),
      logger: lName,
      message: tMsg,
      ...variables,
    },
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
    if (this.Timers.has(name)) {
      const cTime = new Date();
      const diff = cTime.getTime() - this.Timers.get(name).getTime();

      this.Timers.delete(name);

      return diff;
    }

    return 0;
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
  public abstract trace(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract debug(message: string, ...args: any[]): void;
  public abstract debug(err: Error, message: string, ...args: any[]): void;
  public abstract debug(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract info(message: string, ...args: any[]): void;
  public abstract info(err: Error, message: string, ...args: any[]): void;
  public abstract info(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract warn(message: string, ...args: any[]): void;
  public abstract warn(err: Error, message: string, ...args: any[]): void;
  public abstract warn(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract error(message: string, ...args: any[]): void;
  public abstract error(err: Error, message: string, ...args: any[]): void;
  public abstract error(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract fatal(message: string, ...args: any[]): void;
  public abstract fatal(err: Error, message: string, ...args: any[]): void;
  public abstract fatal(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract security(message: string, ...args: any[]): void;
  public abstract security(err: Error, message: string, ...args: any[]): void;
  public abstract security(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract success(message: string, ...args: any[]): void;
  public abstract success(err: Error, message: string, ...args: any[]): void;
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
        const found = allLoggers.find((l) => l.Name === name);

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

