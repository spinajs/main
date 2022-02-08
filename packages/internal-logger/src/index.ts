import { DI } from "@spinajs/di";
import { ILogTargetData, LogLevel, createLogMessageObject } from "@spinajs/log-common";

/**
 * This class is used only in some spinajs packages
 * to avoid circular dependencies with logger and/or config packages
 * 
 * It should not be used in production
 */
export class InternalLogger {
  protected static LogBuffer: Map<string, ILogTargetData[]> = new Map();

  public static trace(message: string, name: string, ...args: any[]): void;
  public static trace(err: Error, message: string, name: string, ...args: any[]): void;
  public static trace(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger.write(err, message, LogLevel.Trace, name, ...args);
  }

  public static debug(message: string, name: string, ...args: any[]): void;
  public static debug(err: Error, message: string, name: string, ...args: any[]): void;
  public static debug(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger.write(err, message, LogLevel.Debug, name, ...args);
  }

  public static info(message: string, name: string, ...args: any[]): void;
  public static info(err: Error, message: string, name: string, ...args: any[]): void;
  public static info(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger.write(err, message, LogLevel.Info, name, ...args);
  }

  public static warn(message: string, name: string, ...args: any[]): void;
  public static warn(err: Error, message: string, name: string, ...args: any[]): void;
  public static warn(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger.write(err, message, LogLevel.Warn, name, ...args);
  }

  public static error(message: string, name: string, ...args: any[]): void;
  public static error(err: Error, message: string, name: string, ...args: any[]): void;
  public static error(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger.write(err, message, LogLevel.Error, name, ...args);
  }

  public static fatal(message: string, name: string, ...args: any[]): void;
  public static fatal(err: Error, message: string, name: string, ...args: any[]): void;
  public static fatal(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger.write(err, message, LogLevel.Fatal, name, ...args);
  }

  public static security(message: string, name: string, ...args: any[]): void;
  public static security(err: Error, message: string, name: string, ...args: any[]): void;
  public static security(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger.write(err, message, LogLevel.Security, name, ...args);
  }

  public static success(message: string, name: string, ...args: any[]): void;
  public static success(err: Error, message: string, name: string, ...args: any[]): void;
  public static success(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    InternalLogger.write(err, message, LogLevel.Success, name, ...args);
  }

  protected static write(err: Error | string, message: string | any[], level: LogLevel, name: string, ...args: any[]) {
    const msg = createLogMessageObject(err, message, level, name, {}, ...args);
    const logName = name ?? (message as string);

    if (DI.has("__log__")) {
      const logger = DI.resolve("__log__", [logName]);
      if (logger) {
        logger.Targets.forEach((t) => {
          t.instance.write(msg).catch((err) => {
            console.error(err);
          });
        });
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
