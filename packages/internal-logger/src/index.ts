/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Bootstrapper, DI, Injectable } from "@spinajs/di";
import { Configuration, format } from "@spinajs/configuration-common";
import { ILogEntry, LogLevel, createLogMessageObject, Log, ILogTargetDesc, LogVariables } from "@spinajs/log-common";
import _ from "lodash";
import chalk from "chalk";


/**
 * This class is used only in some spinajs packages
 * to avoid circular dependencies with logger and/or config packages
 *
 * It should not be used in production
 */

function writeLogEntry(entry: ILogEntry, logName: string) {
  const logger: Log = DI.resolve("__log__", [logName]);
  if (logger) {
    logger
      .write(entry)
      .then((values) => {
        values.forEach((v) => {
          if (v.status === "rejected") {
            console.error(
              `Couldnt write to logger ${logName} message ${JSON.stringify({
                level: entry.Level,
                vars: _.pick(entry.Variables, ["message"]),
              })}, reason: ${v.reason as string}`
            );
          }
        });

        return;
      })
      .catch(null);
  }
}

@Injectable(Bootstrapper)
export class InternalLogger extends Bootstrapper {
  protected theme: any[] = [];
  protected StdConsoleCallbackMap = {
    [LogLevel.Error]: console.error,
    [LogLevel.Fatal]: console.error,
    [LogLevel.Security]: console.error,

    [LogLevel.Info]: console.log,
    [LogLevel.Success]: console.log,

    [LogLevel.Trace]: console.debug,
    [LogLevel.Debug]: console.debug,

    [LogLevel.Warn]: console.warn,
  };

  public bootstrap(): void {
    const write = () => {
      InternalLogger.LogBuffer.forEach((entry) => {
        writeLogEntry(entry, entry.Variables.logger);
      });
      InternalLogger.LogBuffer = [];
    };

    // We must wait for configuration to load
    // becouse log is dependent on it
    // when configuration system is resolved
    // write all buffered messages to it
    if (DI.has(Configuration)) {
      // if we botstrapped before logger
      write();
    } else {
      // if not wait for event to occur
      DI.once("di.resolved.Configuration", () => {
        write();
      });
    }

    process.on("beforeExit", () => {
      this.theme[LogLevel.Trace] = chalk.gray;
      this.theme[LogLevel.Debug] = chalk.gray;
      this.theme[LogLevel.Info] = chalk.white;
      this.theme[LogLevel.Success] = chalk.white.bgGreen;
      this.theme[LogLevel.Warn] = chalk.yellow;
      this.theme[LogLevel.Error] = chalk.red;
      this.theme[LogLevel.Fatal] = chalk.white.bgRed;
      this.theme[LogLevel.Security] = chalk.yellow.bgRed;

      // when application is about to exit, write all messages to console
      // if buffer is not empty it mean, that we cannot write to normal logger

      InternalLogger.LogBuffer.forEach((entry) => {
        this.StdConsoleCallbackMap[entry.Level]((this.theme as any)[entry.Level](format(entry.Variables, "${datetime} ${level} ${message} ${error} (" + entry.Variables.logger + ")")));
      });
      InternalLogger.LogBuffer = [];
    });
  }

  protected static LogBuffer: ILogEntry[] =[];

  private static _write(err: Error | string, message: string, name: string, level: LogLevel, ...args: any[]) {
    if (err instanceof Error) {
      InternalLogger.write(err, message, level, name, {}, ...args);
    } else {
      InternalLogger.write(null, err, level, message, {}, [name, ...args]);
    }
  }

  public static trace(message: string, name: string, ...args: any[]): void;
  public static trace(err: Error, message: string, name: string, ...args: any[]): void;
  public static trace(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger.write(err, message, LogLevel.Trace, name, {}, ...args);
  }

  public static debug(message: string, name: string, ...args: any[]): void;
  public static debug(err: Error, message: string, name: string, ...args: any[]): void;
  public static debug(err: Error | string, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Debug, ...args);
  }

  public static info(message: string, name: string, ...args: any[]): void;
  public static info(err: Error, message: string, name: string, ...args: any[]): void;
  public static info(err: Error | string, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Info, ...args);
  }

  public static warn(message: string, name: string, ...args: any[]): void;
  public static warn(err: Error, message: string, name: string, ...args: any[]): void;
  public static warn(err: Error | string, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Warn, ...args);
  }

  public static error(message: string, name: string, ...args: any[]): void;
  public static error(err: Error, message: string, name: string, ...args: any[]): void;
  public static error(err: Error | string, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Error, ...args);
  }

  public static fatal(message: string, name: string, ...args: any[]): void;
  public static fatal(err: Error, message: string, name: string, ...args: any[]): void;
  public static fatal(err: Error | string, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Fatal, ...args);
  }

  public static security(message: string, name: string, ...args: any[]): void;
  public static security(err: Error, message: string, name: string, ...args: any[]): void;
  public static security(err: Error | string, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Security, ...args);
  }

  public static success(message: string, name: string, ...args: any[]): void;
  public static success(err: Error, message: string, name: string, ...args: any[]): void;
  public static success(err: Error | string, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Success, ...args);
  }

  public static write(err: Error | string, message: string | any[], level: LogLevel, name: string, vars: Record<string, unknown>, ...args: any[]) {
    const msg = createLogMessageObject(err, message, level, name, vars, ...args);
    InternalLogger.writeLogEntry(msg);
  }

  public static writeLogEntry(entry: ILogEntry) {
    const logName = entry.Variables.logger;
    // when we have log system working, write directly to it
    // first we must check if Configuration module is resolved
    // to obtain information about log targets etc.
    if (DI.has(Configuration)) {
      if (DI.resolve("__log__", [logName])) {
        writeLogEntry(entry, logName);
      } else {
        InternalLogger.writeInternal(entry);
      }
    } else {
      InternalLogger.writeInternal(entry);
    }
  }

  protected static writeInternal(msg: any) {
    InternalLogger.LogBuffer.push(msg);
  }
}

export class InternalLoggerProxy extends Log {
  public Targets: ILogTargetDesc[];
  protected Variables: Record<string, any> = {};
  public Timers: Map<string, Date> = new Map<string, Date>();

  constructor(public Name: string, protected variables?: Record<string, unknown>, protected Parent?: Log) {
    super();
  }

  trace(message: string, ...args: any[]): void;
  trace(err: Error, message: string, ...args: any[]): void;
  trace(err: string | Error, message: string | any[], ...args: any[]): void;
  trace(err: Error | string, message?: unknown, ...args: unknown[]): void {
    InternalLogger.trace(err as any, message as any, this.Name, ...args);
  }

  debug(message: string, ...args: any[]): void;
  debug(err: Error, message: string, ...args: any[]): void;
  debug(err: string | Error, message: string | any[], ...args: any[]): void;
  debug(err: unknown, message?: unknown, ...args: unknown[]): void {
    InternalLogger.debug(err as any, message as any, this.Name, ...args);
  }

  info(message: string, ...args: any[]): void;
  info(err: Error, message: string, ...args: any[]): void;
  info(err: string | Error, message: string | any[], ...args: any[]): void;
  info(err: unknown, message?: unknown, ...args: unknown[]): void {
    InternalLogger.info(err as any, message as any, this.Name, ...args);
  }

  warn(message: string, ...args: any[]): void;
  warn(err: Error, message: string, ...args: any[]): void;
  warn(err: string | Error, message: string | any[], ...args: any[]): void;
  warn(err: unknown, message?: unknown, ...args: unknown[]): void {
    InternalLogger.warn(err as any, message as any, this.Name, ...args);
  }

  error(message: string, ...args: any[]): void;
  error(err: Error, message: string, ...args: any[]): void;
  error(err: string | Error, message: string | any[], ...args: any[]): void;
  error(err: unknown, message?: unknown, ...args: unknown[]): void {
    InternalLogger.error(err as any, message as any, this.Name, ...args);
  }

  fatal(message: string, ...args: any[]): void;
  fatal(err: Error, message: string, ...args: any[]): void;
  fatal(err: string | Error, message: string | any[], ...args: any[]): void;
  fatal(err: unknown, message?: unknown, ...args: unknown[]): void {
    InternalLogger.fatal(err as any, message as any, this.Name, ...args);
  }

  security(message: string, ...args: any[]): void;
  security(err: Error, message: string, ...args: any[]): void;
  security(err: string | Error, message: string | any[], ...args: any[]): void;
  security(err: unknown, message?: unknown, ...args: unknown[]): void {
    InternalLogger.security(err as any, message as any, this.Name, ...args);
  }

  success(message: string, ...args: any[]): void;
  success(err: Error, message: string, ...args: any[]): void;
  success(err: string | Error, message: string | any[], ...args: any[]): void;
  success(err: unknown, message?: unknown, ...args: unknown[]): void {
    InternalLogger.success(err as any, message as any, this.Name, ...args);
  }
  child(_name: string, _variables?: LogVariables): Log {
    return this;
  }
  write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    Object.assign(entry.Variables, this.Variables);
    InternalLogger.writeLogEntry(entry);
    return Promise.allSettled([]);
  }
  addVariable(name: string, value: unknown): void {
    this.Variables[`${name}`] = value;
  }
  timeStart(name: string): void {
    if (this.Timers.has(name)) {
      return;
    }

    this.Timers.set(name, new Date());
  }
  timeEnd(name: string): number {
    if (this.Timers.has(name)) {
      const cTime = new Date();
      const diff = cTime.getTime() - this.Timers.get(name).getTime();

      this.Timers.delete(name);

      return diff;
    }

    return 0;
  }
}
