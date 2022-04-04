import { SyncModule } from "@spinajs/di";
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
  level:
    | "trace"
    | "debug"
    | "info"
    | "warn"
    | "error"
    | "fatal"
    | "security"
    | "success";
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
     * How mutch archive files should be preserved before deletion. Default is 0
     * Eg. to store max 5 archive files, set it to 5. Oldest by modification time are deleted.
     */
    maxArchiveFiles: number;
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

export abstract class LogTarget<
  T extends ICommonTargetOptions
> extends SyncModule {
  public HasError = false;
  public Error: Error | null | unknown = null;
  public Options: T;

  constructor(options: T) {
    super();

    if (options) {
      this.Options = _.merge(
        _.merge(this.Options, {
          enabled: true,
          layout: "${datetime} ${level} ${message} ${error} (${logger})",
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
export interface ILog {
  Targets: ILogTargetDesc[];

  trace(message: string, ...args: any[]): void;
  trace(err: Error, message: string, ...args: any[]): void;
  trace(err: Error | string, message: string | any[], ...args: any[]): void;

  debug(message: string, ...args: any[]): void;
  debug(err: Error, message: string, ...args: any[]): void;
  debug(err: Error | string, message: string | any[], ...args: any[]): void;

  info(message: string, ...args: any[]): void;
  info(err: Error, message: string, ...args: any[]): void;
  info(err: Error | string, message: string | any[], ...args: any[]): void;

  warn(message: string, ...args: any[]): void;
  warn(err: Error, message: string, ...args: any[]): void;
  warn(err: Error | string, message: string | any[], ...args: any[]): void;

  error(message: string, ...args: any[]): void;
  error(err: Error, message: string, ...args: any[]): void;
  error(err: Error | string, message: string | any[], ...args: any[]): void;

  fatal(message: string, ...args: any[]): void;
  fatal(err: Error, message: string, ...args: any[]): void;
  fatal(err: Error | string, message: string | any[], ...args: any[]): void;

  security(message: string, ...args: any[]): void;
  security(err: Error, message: string, ...args: any[]): void;
  security(err: Error | string, message: string | any[], ...args: any[]): void;

  success(message: string, ...args: any[]): void;
  success(err: Error, message: string, ...args: any[]): void;
  success(err: Error | string, message: string | any[], ...args: any[]): void;

  child(name: string, variables?: LogVariables): ILog;

  write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]>;

  addVariable(name: string, value: unknown): void;

  timeStart(name: string): void;
  timeEnd(name: string): number;
}

export type LogVariables = ILogStaticVariables & ILogVariable;

export function createLogMessageObject(
  err: Error | string,
  message: string | any[],
  level: LogLevel,
  logger: string,
  variables: any,
  ...args: any[]
): ILogEntry {
  const sMsg = err instanceof Error ? (message as string) : err;
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
