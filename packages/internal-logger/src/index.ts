/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Bootstrapper, DI, Injectable, NewInstance } from "@spinajs/di";
import { Configuration, format } from "@spinajs/configuration-common";
import { ILogEntry, LogLevel, createLogMessageObject, renderTemplate, Log, ILogTargetDesc, LogVariables, LOG } from "@spinajs/log-common";
import _ from "lodash";
import { DateTime } from "luxon";

/**
 * Minimal, dependency-free ANSI colour helpers ( replaces chalk ).
 * This path is Node-only ( process `beforeExit` ), so raw escape codes are fine.
 */
const ANSI_RESET = "\x1b[0m";
const ansi = (open: string) => (text: string) => `${open}${text}${ANSI_RESET}`;
const gray = ansi("\x1b[90m");
const white = ansi("\x1b[37m");
const whiteBgGreen = ansi("\x1b[37m\x1b[42m");
const yellow = ansi("\x1b[33m");
const red = ansi("\x1b[31m");
const whiteBgRed = ansi("\x1b[37m\x1b[41m");
const yellowBgRed = ansi("\x1b[33m\x1b[41m");


/**
 * This class is used only in some spinajs packages
 * to avoid circular dependencies with logger and/or config packages
 *
 * It should not be used in production
 */

function writeLogEntry(entry: ILogEntry, logName: string): boolean {
  const logger: Log = DI.resolve(LOG, [logName]);
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
      .catch((err) => {
        console.error(`Couldnt write to logger ${logName}, reason: ${err as string}`);
      });
  }

  return !!logger;
}

/**
 * Builds an entry from the `Log` call forms: ( err, message, ...args ),
 * ( fields, template, ...args ) and ( format, ...args ).
 */
function createEntry(err: unknown, message: unknown, level: LogLevel, name: string, vars: Record<string, unknown>, args: unknown[]): ILogEntry {
  if (err instanceof Error) {
    return createLogMessageObject(err, message as string, level, name, vars, ...args);
  }

  if (err !== null && typeof err === "object" && !Array.isArray(err)) {
    // merging-object form: `err` is a bag of structured fields, `message` is the
    // `${field}` template ( see renderTemplate ). Fields are spread into the log variables ( so a nested
    // `error` key still runs the serializer ).
    const fields = err as Record<string, unknown>;
    const fmt = typeof message === "string" ? renderTemplate(message, fields, args.length !== 0) : "";
    return createLogMessageObject(null as any, fmt, level, name, { ...vars, ...fields }, ...args);
  }

  return createLogMessageObject(err as string, null as any, level, name, vars, ...(message !== undefined ? [message, ...args] : args));
}

const DefaultDateTimeFormat = "dd/MM/yyyy HH:mm:ss.SSS ZZ";

@Injectable(Bootstrapper)
export class InternalLogger extends Bootstrapper {
  protected theme: any[] = Object.assign([], {
    [LogLevel.Trace]: gray,
    [LogLevel.Debug]: gray,
    [LogLevel.Info]: white,
    [LogLevel.Success]: whiteBgGreen,
    [LogLevel.Warn]: yellow,
    [LogLevel.Error]: red,
    [LogLevel.Fatal]: whiteBgRed,
    [LogLevel.Security]: yellowBgRed,
  });
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

  // Per process, not per instance: a restored DI container resolves a new bootstrapper for every app it boots.
  private static exitDumpAttached = false;

  public bootstrap(): void {
    const write = () => {
      const pending = InternalLogger.LogBuffer;
      InternalLogger.LogBuffer = [];
      pending.forEach((entry) => {
        if (!writeLogEntry(entry, entry.Variables.logger)) {
          InternalLogger.writeInternal(entry);
        }
      });
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

    // Node-only: flush any buffered messages to the console on exit.
    // Guard so the browser ( no `process` ) never touches this path.
    if (!InternalLogger.exitDumpAttached && typeof process !== "undefined" && typeof process.on === "function") {
      InternalLogger.exitDumpAttached = true;
      process.on("beforeExit", () => {
        // when application is about to exit, write all messages to console
        // if buffer is not empty it mean, that we cannot write to normal logger

        InternalLogger.LogBuffer.forEach((entry) => {
          const loggedAt = DateTime.fromJSDate(InternalLogger.LoggedAt.get(entry) ?? new Date());
          const vars = { ...entry.Variables, datetime: (fmt?: string) => loggedAt.toFormat(fmt ?? DefaultDateTimeFormat) };
          this.StdConsoleCallbackMap[entry.Level]((this.theme as any)[entry.Level](format(vars, "${datetime} ${level} ${message} ${error:message} (" + entry.Variables.logger + ")")));
        });
        InternalLogger.LogBuffer = [];
      });
    }
  }

  protected static LogBuffer: ILogEntry[] = [];

  /**
   * Max entries kept in the buffer; the oldest are dropped first.
   */
  public static LogBufferLimit = 1000;

  private static LoggedAt = new WeakMap<ILogEntry, Date>();

  private static _write(err: Error | string | object, message: string, name: string, level: LogLevel, ...args: any[]) {
    if (err instanceof Error || (err !== null && typeof err === "object" && !Array.isArray(err))) {
      InternalLogger.writeLogEntry(createEntry(err, message, level, name, {}, args));
    } else {
      // string form is ( message, name, ...args ): the second argument is the logger name
      InternalLogger.writeLogEntry(createEntry(err, undefined, level, message, {}, name !== undefined ? [name, ...args] : args));
    }
  }

  public static trace(message: string, name: string, ...args: any[]): void;
  public static trace(err: Error, message: string, name: string, ...args: any[]): void;
  public static trace(fields: object, message: string, name: string, ...args: any[]): void;
  public static trace(err: Error | string | object, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger._write(err, message as string, name, LogLevel.Trace, ...args);
  }

  public static debug(message: string, name: string, ...args: any[]): void;
  public static debug(err: Error, message: string, name: string, ...args: any[]): void;
  public static debug(fields: object, message: string, name: string, ...args: any[]): void;
  public static debug(err: Error | string | object, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Debug, ...args);
  }

  public static info(message: string, name: string, ...args: any[]): void;
  public static info(err: Error, message: string, name: string, ...args: any[]): void;
  public static info(fields: object, message: string, name: string, ...args: any[]): void;
  public static info(err: Error | string | object, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Info, ...args);
  }

  public static warn(message: string, name: string, ...args: any[]): void;
  public static warn(err: Error, message: string, name: string, ...args: any[]): void;
  public static warn(fields: object, message: string, name: string, ...args: any[]): void;
  public static warn(err: Error | string | object, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Warn, ...args);
  }

  public static error(message: string, name: string, ...args: any[]): void;
  public static error(err: Error, message: string, name: string, ...args: any[]): void;
  public static error(fields: object, message: string, name: string, ...args: any[]): void;
  public static error(err: Error | string | object, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Error, ...args);
  }

  public static fatal(message: string, name: string, ...args: any[]): void;
  public static fatal(err: Error, message: string, name: string, ...args: any[]): void;
  public static fatal(fields: object, message: string, name: string, ...args: any[]): void;
  public static fatal(err: Error | string | object, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Fatal, ...args);
  }

  public static security(message: string, name: string, ...args: any[]): void;
  public static security(err: Error, message: string, name: string, ...args: any[]): void;
  public static security(fields: object, message: string, name: string, ...args: any[]): void;
  public static security(err: Error | string | object, message: string, name: string, ...args: any[]): void {
    InternalLogger._write(err, message, name, LogLevel.Security, ...args);
  }

  public static success(message: string, name: string, ...args: any[]): void;
  public static success(err: Error, message: string, name: string, ...args: any[]): void;
  public static success(fields: object, message: string, name: string, ...args: any[]): void;
  public static success(err: Error | string | object, message: string, name: string, ...args: any[]): void {
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
      if (DI.resolve(LOG, [logName])) {
        writeLogEntry(entry, logName);
      } else {
        InternalLogger.writeInternal(entry);
      }
    } else {
      InternalLogger.writeInternal(entry);
    }
  }

  protected static writeInternal(msg: any) {
    if (!InternalLogger.LoggedAt.has(msg)) {
      InternalLogger.LoggedAt.set(msg, new Date());
    }

    InternalLogger.LogBuffer.push(msg);
    if (InternalLogger.LogBuffer.length > InternalLogger.LogBufferLimit) {
      InternalLogger.LogBuffer.splice(0, InternalLogger.LogBuffer.length - InternalLogger.LogBufferLimit);
    }
  }
}

/**
 * Bootstrap-time proxy used before the real logger / configuration is resolved.
 *
 * It inherits the concrete runtime level-control API from {@link Log }
 * ( getLevel / setLevel / setDefaultLevel / resetLevel / enableAll / disableAll ).
 * These are harmless here: the proxy keeps the default `MinLevel = Trace`, has no
 * per-method isEnabled() guard, and forwards every call straight to
 * `InternalLogger`, so `setLevel(...)` on the proxy simply has no gating effect.
 */
@NewInstance()
export class InternalLoggerProxy extends Log {
  public Targets: ILogTargetDesc[];
  protected Variables: Record<string, any> = {};
  public Timers: Map<string, Date> = new Map<string, Date>();

  constructor(public Name: string, protected variables?: Record<string, unknown>, protected Parent?: Log) {
    super();
    Object.assign(this.Variables, variables);
  }

  private writeLevel(level: LogLevel, err: unknown, message: unknown, args: unknown[]) {
    InternalLogger.writeLogEntry(createEntry(err, message, level, this.Name, this.Variables, args));
  }

  trace(message: string, ...args: any[]): void;
  trace(err: Error, message: string, ...args: any[]): void;
  trace(fields: object, message?: string, ...args: any[]): void;
  trace(err: string | Error, message: string | any[], ...args: any[]): void;
  trace(err: Error | string | object, message?: unknown, ...args: unknown[]): void {
    this.writeLevel(LogLevel.Trace, err, message, args);
  }

  debug(message: string, ...args: any[]): void;
  debug(err: Error, message: string, ...args: any[]): void;
  debug(fields: object, message?: string, ...args: any[]): void;
  debug(err: string | Error, message: string | any[], ...args: any[]): void;
  debug(err: unknown, message?: unknown, ...args: unknown[]): void {
    this.writeLevel(LogLevel.Debug, err, message, args);
  }

  info(message: string, ...args: any[]): void;
  info(err: Error, message: string, ...args: any[]): void;
  info(fields: object, message?: string, ...args: any[]): void;
  info(err: string | Error, message: string | any[], ...args: any[]): void;
  info(err: unknown, message?: unknown, ...args: unknown[]): void {
    this.writeLevel(LogLevel.Info, err, message, args);
  }

  warn(message: string, ...args: any[]): void;
  warn(err: Error, message: string, ...args: any[]): void;
  warn(fields: object, message?: string, ...args: any[]): void;
  warn(err: string | Error, message: string | any[], ...args: any[]): void;
  warn(err: unknown, message?: unknown, ...args: unknown[]): void {
    this.writeLevel(LogLevel.Warn, err, message, args);
  }

  error(message: string, ...args: any[]): void;
  error(err: Error, message: string, ...args: any[]): void;
  error(fields: object, message?: string, ...args: any[]): void;
  error(err: string | Error, message: string | any[], ...args: any[]): void;
  error(err: unknown, message?: unknown, ...args: unknown[]): void {
    this.writeLevel(LogLevel.Error, err, message, args);
  }

  fatal(message: string, ...args: any[]): void;
  fatal(err: Error, message: string, ...args: any[]): void;
  fatal(fields: object, message?: string, ...args: any[]): void;
  fatal(err: string | Error, message: string | any[], ...args: any[]): void;
  fatal(err: unknown, message?: unknown, ...args: unknown[]): void {
    this.writeLevel(LogLevel.Fatal, err, message, args);
  }

  security(message: string, ...args: any[]): void;
  security(err: Error, message: string, ...args: any[]): void;
  security(fields: object, message?: string, ...args: any[]): void;
  security(err: string | Error, message: string | any[], ...args: any[]): void;
  security(err: unknown, message?: unknown, ...args: unknown[]): void {
    this.writeLevel(LogLevel.Security, err, message, args);
  }

  success(message: string, ...args: any[]): void;
  success(err: Error, message: string, ...args: any[]): void;
  success(fields: object, message?: string, ...args: any[]): void;
  success(err: string | Error, message: string | any[], ...args: any[]): void;
  success(err: unknown, message?: unknown, ...args: unknown[]): void {
    this.writeLevel(LogLevel.Success, err, message, args);
  }
  child(name: string, variables?: LogVariables): Log {
    return new InternalLoggerProxy(`${this.Name}.${name}`, { ...this.Variables, ...variables }, this);
  }
  write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    InternalLogger.writeLogEntry({ ...entry, Variables: { ...this.Variables, ...entry.Variables } });
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
    const timer = this.Timers.get(name)
    if (timer) {
      const cTime = new Date();
      const diff = cTime.getTime() - timer.getTime();

      this.Timers.delete(name);

      return diff;
    }

    return 0;
  }
}
