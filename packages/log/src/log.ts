/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Configuration } from "@spinajs/configuration/lib/types";
import { Autoinject, Container, DI, IContainer, NewInstance, SyncModule } from "@spinajs/di";
import { ILogTargetDesc, LogTarget } from "./targets/LogTarget";
import { ICommonTargetOptions, LogLevel, ILogOptions, ILogRule, ILogEntry, StrToLogLevel, LogVariables, createLogMessageObject, ILog } from "@spinajs/log-common";
import * as globToRegexp from "glob-to-regexp";
import { InvalidOption } from "@spinajs/exceptions";

function wrapWrite(this: Log, level: LogLevel) {
  return (err: Error | string, message: string | any[], ...args: any[]) => {
    if (err instanceof Error) {
      return this.write(createLogMessageObject(err, message, level, this.Name, this.Variables, ...args));
    } else {
      if (message) {
        return this.write(createLogMessageObject(err, null, level, this.Name, this.Variables, ...[message, ...args]));
      } else {
        return this.write(createLogMessageObject(err, null, level, this.Name, this.Variables, ...args));
      }
    }
  };
}

/**
 * Default log implementation interface. Taken from bunyan. Feel free to implement own.
 */
@NewInstance()
export class Log extends SyncModule implements ILog {
  /**
   *  STATIC METHODS FOR LOGGER, ALLOWS TO LOG TO ANY TARGET
   *  EVEN BEFORE LOG MODULE INITIALIZATION.
   *
   *  Prevents from losing log message when initializing modules
   */
  public static Loggers: Map<string, Log> = new Map();
  public Timers: Map<string, Date> = new Map<string, Date>();

  public static clearLoggers() {
    Log.Loggers.clear();
  }

  protected static AttachedToExitEvents = false;

  protected Options: ILogOptions;

  protected Rules: ILogRule[];

  protected Targets: ILogTargetDesc[];

  protected Variables: Record<string, any> = {};

  @Autoinject()
  protected Container: Container;

  constructor(public Name: string, variables?: Record<string, unknown>, protected Parent?: Log) {
    super();

    this.Variables = variables ?? {};
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

  public resolve(): void {
    const config = this.Container.get(Configuration);

    if (!config) {
      throw new Error(`Configuration module is not avaible. Please resolve configuration module before any logging can occur`);
    }

    this.Options = config.get<ILogOptions>("logger", {
      targets: [
        {
          name: "Console",
          type: "ConsoleTarget",
        },
      ],
      rules: [{ name: "*", level: "trace", target: "Console" }],
    });

    this.matchRulesToLogger();
    this.resolveLogTargets();

    super.resolve();

    Log.Loggers.set(this.Name, this);
  }

  public trace(message: string, ...args: any[]): void;
  public trace(err: Error, message: string, ...args: any[]): void;
  public trace(err: Error | string, message: string | any[], ...args: any[]): void {
    wrapWrite.apply(this, [LogLevel.Trace])(err, message, ...args);
  }

  public debug(message: string, ...args: any[]): void;
  public debug(err: Error, message: string, ...args: any[]): void;
  public debug(err: Error | string, message: string | any[], ...args: any[]): void {
    wrapWrite.apply(this, [LogLevel.Debug])(err, message, ...args);
  }

  public info(message: string, ...args: any[]): void;
  public info(err: Error, message: string, ...args: any[]): void;
  public info(err: Error | string, message: string | any[], ...args: any[]): void {
    wrapWrite.apply(this, [LogLevel.Info])(err, message, ...args);
  }

  public warn(message: string, ...args: any[]): void;
  public warn(err: Error, message: string, ...args: any[]): void;
  public warn(err: Error | string, message: string | any[], ...args: any[]): void {
    wrapWrite.apply(this, [LogLevel.Warn])(err, message, ...args);
  }

  public error(message: string, ...args: any[]): void;
  public error(err: Error, message: string, ...args: any[]): void;
  public error(err: Error | string, message: string | any[], ...args: any[]): void {
    wrapWrite.apply(this, [LogLevel.Error])(err, message, ...args);
  }

  public fatal(message: string, ...args: any[]): void;
  public fatal(err: Error, message: string, ...args: any[]): void;
  public fatal(err: Error | string, message: string | any[], ...args: any[]): void {
    wrapWrite.apply(this, [LogLevel.Fatal])(err, message, ...args);
  }

  public security(message: string, ...args: any[]): void;
  public security(err: Error, message: string, ...args: any[]): void;
  public security(err: Error | string, message: string | any[], ...args: any[]): void {
    wrapWrite.apply(this, [LogLevel.Security])(err, message, ...args);
  }

  public success(message: string, ...args: any[]): void;
  public success(err: Error, message: string, ...args: any[]): void;
  public success(err: Error | string, message: string | any[], ...args: any[]): void {
    wrapWrite.apply(this, [LogLevel.Success])(err, message, ...args);
  }

  public write(entry: ILogEntry) {
    if (entry.Variables.logger === this.Name) {
      return Promise.allSettled(this.Targets.filter((t) => entry.Level >= StrToLogLevel[t.rule.level]).map((t) => t.instance.write(entry)));
    }
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

  protected resolveLogTargets() {
    this.Targets = this.Rules.map((r) => {
      const found = this.Options.targets.filter((t) => {
        return Array.isArray(r.target) ? r.target.includes(t.name) : r.target === t.name;
      });

      if (!found) {
        throw new InvalidOption(`No target matching rule ${r.name}`);
      }

      return found.map((f) => {
        return {
          instance: DI.resolve<LogTarget<ICommonTargetOptions>>(f.type, [f]),
          options: f,
          rule: r,
        };
      });
    }).reduce((prev: ILogTargetDesc[], curr: ILogTargetDesc[]) => prev.concat(...curr), []);
  }

  protected matchRulesToLogger() {
    this.Rules = this.Options.rules.filter((r) => {
      return globToRegexp(r.name).test(this.Name);
    });
  }
}

const logFactoryFunction = (container: IContainer, logName: string) => {
  if (Log.Loggers.has(logName)) {
    return Log.Loggers.get(logName);
  }

  return container.resolve("__logImplementation__", [logName]);
};

// register as string identifier to allow for
// resolving logs without referencing class
// to avoid circular dependencies in some @spinajs packages
// it should not be used in production code
DI.register(logFactoryFunction).as("__log__");

// register log factory function as Log class
// this way we can create or return already created
// log objects
DI.register(logFactoryFunction).as(Log);

// register Log class as string literal
// so we can resolve Log class
// it should not be used in production code
DI.register(Log).as("__logImplementation__");
