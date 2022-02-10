import { Bootstrapper, DI, Injectable } from "@spinajs/di";
import {
  ILogEntry,
  LogLevel,
  createLogMessageObject,
  ILog,
} from "@spinajs/log-common";

/**
 * This class is used only in some spinajs packages
 * to avoid circular dependencies with logger and/or config packages
 *
 * It should not be used in production
 */
@Injectable(Bootstrapper)
export class InternalLogger extends Bootstrapper {
  public bootstrap(): void | Promise<void> {
    const write = () => {
      InternalLogger.LogBuffer.forEach((value, lName) => {
        const logger: ILog = DI.resolve("__log__", [lName]);
        if (logger) {
          value.forEach((msg) => {
            logger
              .write(msg)
              .then((values) => {
                values.forEach((v) => {
                  if (v.status === "rejected") {
                    console.error(
                      `Couldnt write to logger ${lName} message ${JSON.stringify(
                        msg
                      )}, reason: ${v.reason as string}`
                    );
                  }
                });

                return;
              })
              .catch(null);
          });
        }
      });
      InternalLogger.LogBuffer.clear();
    };

    // We must wait for configuration to load
    // becouse log is dependent on it
    // when configuration system is resolved
    // write all buffered messages to it
    if (DI.has("Configuration")) {
      // if we botstrapped before logger
      write();
    } else {
      // if not wait for event to occur
      DI.once("di.resolved.Configuration", () => write());
    }
  }

  protected static LogBuffer: Map<string, ILogEntry[]> = new Map();

  public static trace(message: string, name: string, ...args: any[]): void;
  public static trace(
    err: Error,
    message: string,
    name: string,
    ...args: any[]
  ): void;
  public static trace(
    err: Error | string,
    message: string | any[],
    name: string,
    ...args: any[]
  ): void {
    InternalLogger.write(err, message, LogLevel.Trace, name, ...args);
  }

  public static debug(message: string, name: string, ...args: any[]): void;
  public static debug(
    err: Error,
    message: string,
    name: string,
    ...args: any[]
  ): void;
  public static debug(
    err: Error | string,
    message: string | any[],
    name: string,
    ...args: any[]
  ): void {
    InternalLogger.write(err, message, LogLevel.Debug, name, ...args);
  }

  public static info(message: string, name: string, ...args: any[]): void;
  public static info(
    err: Error,
    message: string,
    name: string,
    ...args: any[]
  ): void;
  public static info(
    err: Error | string,
    message: string | any[],
    name: string,
    ...args: any[]
  ): void {
    InternalLogger.write(err, message, LogLevel.Info, name, ...args);
  }

  public static warn(message: string, name: string, ...args: any[]): void;
  public static warn(
    err: Error,
    message: string,
    name: string,
    ...args: any[]
  ): void;
  public static warn(
    err: Error | string,
    message: string | any[],
    name: string,
    ...args: any[]
  ): void {
    InternalLogger.write(err, message, LogLevel.Warn, name, ...args);
  }

  public static error(message: string, name: string, ...args: any[]): void;
  public static error(
    err: Error,
    message: string,
    name: string,
    ...args: any[]
  ): void;
  public static error(
    err: Error | string,
    message: string | any[],
    name: string,
    ...args: any[]
  ): void {
    InternalLogger.write(err, message, LogLevel.Error, name, ...args);
  }

  public static fatal(message: string, name: string, ...args: any[]): void;
  public static fatal(
    err: Error,
    message: string,
    name: string,
    ...args: any[]
  ): void;
  public static fatal(
    err: Error | string,
    message: string | any[],
    name: string,
    ...args: any[]
  ): void {
    InternalLogger.write(err, message, LogLevel.Fatal, name, ...args);
  }

  public static security(message: string, name: string, ...args: any[]): void;
  public static security(
    err: Error,
    message: string,
    name: string,
    ...args: any[]
  ): void;
  public static security(
    err: Error | string,
    message: string | any[],
    name: string,
    ...args: any[]
  ): void {
    InternalLogger.write(err, message, LogLevel.Security, name, ...args);
  }

  public static success(message: string, name: string, ...args: any[]): void;
  public static success(
    err: Error,
    message: string,
    name: string,
    ...args: any[]
  ): void;
  public static success(
    err: Error | string,
    message: string | any[],
    name: string,
    ...args: any[]
  ): void {
    InternalLogger.write(err, message, LogLevel.Success, name, ...args);
  }

  protected static write(
    err: Error | string,
    message: string | any[],
    level: LogLevel,
    name: string,
    ...args: any[]
  ) {
    const msg = createLogMessageObject(err, message, level, name, {}, ...args);
    const logName = name ?? (message as string);

    // when we have log system working, write directly to it
    if (DI.has("logger")) {
      const logger: ILog = DI.resolve("__log__", [logName]);
      if (logger) {
        // eslint-disable-next-line promise/no-promise-in-callback
        logger
          .write(msg)
          .then((values) => {
            values.forEach((v) => {
              if (v.status === "rejected") {
                console.error(v.reason);
              }
            });

            return;
          })
          .catch(null);
      } else {
        InternalLogger.writeInternal(msg, logName);
      }
    } else {
      InternalLogger.writeInternal(msg, logName);
    }
  }

  protected static writeInternal(msg: any, logName: string) {
    if (InternalLogger.LogBuffer.has(logName)) {
      InternalLogger.LogBuffer.get(logName).push(msg);
    } else {
      InternalLogger.LogBuffer.set(logName, [msg]);
    }
  }
}
