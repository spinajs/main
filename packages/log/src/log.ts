import { Configuration } from "@spinajs/configuration/lib/types";
import { DI, IContainer, NewInstance, ResolveException, SyncModule } from "@spinajs/di";
import { LogTarget } from "./targets/LogTarget";
import { ICommonTargetOptions, LogLevel, LogLevelStrings, ILogOptions, ILogRule, ILogTargetData, StrToLogLevel, ITargetsOption } from "./types";
import * as util from "util";
import globToRegexp from "glob-to-regexp";
import { InvalidOption } from "@spinajs/exceptions";


function createLogMessageObject(err: Error | string, message: string | any[], level: LogLevel, logger: string, variables: any, ...args: any[]): ILogTargetData {

  const sMsg = (err instanceof Error) ? message as string : err;
  const tMsg = args.length !== 0 ? util.format(sMsg, ...args) : sMsg;
  const lName = logger ?? message;

  return {
    Level: level,
    Variables: {
      error: (err instanceof Error) ? err : undefined,
      level: LogLevelStrings[level].toUpperCase(),
      logger: lName,
      message: tMsg,
      ...variables
    }
  }
}

function wrapWrite(level: LogLevel) {

  const self = this;

  return (err: Error | string, message: string | any[], ...args: any[]): void => {

    if (err instanceof Error) {
      self.write(err, message, level, ...args);
    } else {

      if (message) {
        self.write(err, null, level, ...[message, ...args]);
      } else {
        self.write(err, null, level, ...args);
      }
    }
  }
}


interface ILogTargetDesc {
  instance: LogTarget<ICommonTargetOptions>;
  options?: ITargetsOption;
  rule: ILogRule;
}

/**
 * Default log implementation interface. Taken from bunyan. Feel free to implement own.
 */
@NewInstance()
export class Log extends SyncModule {
  /**
   *  STATIC METHODS FOR LOGGER, ALLOWS TO LOG TO ANY TARGET
   *  EVEN BEFORE LOG MODULE INITIALIZATION. 
   * 
   *  Prevents from losing log message when initializing modules
   */
  public static Loggers: Map<string, Log> = new Map();

  public static trace(message: string, name: string, ...args: any[]): void;
  public static trace(err: Error, message: string, name: string, ...args: any[]): void;
  public static trace(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    Log.write(err, message, LogLevel.Trace, name, ...args);
  }


  public static debug(message: string, name: string, ...args: any[]): void;
  public static debug(err: Error, message: string, name: string, ...args: any[]): void;
  public static debug(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    Log.write(err, message, LogLevel.Debug, name, ...args);
  }

  public static info(message: string, name: string, ...args: any[]): void;
  public static info(err: Error, message: string, name: string, ...args: any[]): void;
  public static info(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    Log.write(err, message, LogLevel.Info, name, ...args);
  }

  public static warn(message: string, name: string, ...args: any[]): void;
  public static warn(err: Error, message: string, name: string, ...args: any[]): void;
  public static warn(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    Log.write(err, message, LogLevel.Warn, name, ...args);
  }

  public static error(message: string, name: string, ...args: any[]): void;
  public static error(err: Error, message: string, name: string, ...args: any[]): void;
  public static error(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    Log.write(err, message, LogLevel.Error, name, ...args);
  }

  public static fatal(message: string, name: string, ...args: any[]): void;
  public static fatal(err: Error, message: string, name: string, ...args: any[]): void;
  public static fatal(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    Log.write(err, message, LogLevel.Fatal, name, ...args);
  }

  public static security(message: string, name: string, ...args: any[]): void;
  public static security(err: Error, message: string, name: string, ...args: any[]): void;
  public static security(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    Log.write(err, message, LogLevel.Security, name, ...args);
  }

  public static success(message: string, name: string, ...args: any[]): void;
  public static success(err: Error, message: string, name: string, ...args: any[]): void;
  public static success(err: Error | string, message: string | any[], name: string, ...args: any[]): void {
    Log.write(err, message, LogLevel.Success, name, ...args);
  }

  public static clearLoggers(){
    Log.Loggers.clear();
  }

  protected static LogBuffer: Map<string, ILogTargetData[]> = new Map();
  protected static AttachedToExitEvents = false;

  protected static write(err: Error | string, message: string | any[], level: LogLevel, name: string, ...args: any[]) {

    const msg = createLogMessageObject(err, message, level, name, {}, ...args);
    const logName = name ?? message as string;

    // if we have already created logger write to it
    if (Log.Loggers.has(logName)) {
      Log.Loggers.get(logName).Targets.forEach(t => t.instance.write(msg));
      return;
    }

    // otherwise store in buffer
    if (Log.LogBuffer.has(logName)) {
      Log.LogBuffer.get(logName).push(msg)
    } else {
      Log.LogBuffer.set(logName, [msg])
    }
  }

  protected Options: ILogOptions;

  protected Rules: ILogRule[];

  protected Targets: ILogTargetDesc[];

  constructor(public Name: string, public Variables?: any, protected Parent?: Log) {
    super();
  }

  public resolve(container: IContainer): void {
 
    const config = container.get(Configuration);
    this.Options = config.get("logger");

    this.matchRulesToLogger();
    this.resolveLogTargets();
    this.writeBufferedMessages();

    super.resolve(container);

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

  public child(name: string, variables?: {}): Log {
    return DI.resolve(Log, [`${this.Name}.${name}`, {
      ...this.Variables,
      ...variables
    }, this]);
  }

  protected writeBufferedMessages() {
    if (Log.LogBuffer.has(this.Name)) {
      Log.LogBuffer.get(this.Name).filter((msg: ILogTargetData) => msg.Variables.logger === this.Name).forEach((msg: ILogTargetData) => {
        this.Targets.forEach(t => t.instance.write(msg));
      });
    }
  }

  protected resolveLogTargets() {
    this.Targets = this.Rules.map(r => {
      const found = this.Options.targets.filter(t => {
        return Array.isArray(r.target) ? r.target.includes(t.name) : r.target === t.name;
      });

      if (!found) {
        throw new InvalidOption(`No target matching rule ${r.target}`);
      }

      return found.map(f => {
        return {
          instance: DI.resolve<LogTarget<ICommonTargetOptions>>(f.type, [f]),
          options: f,
          rule: r
        };
      });
    }).reduce((prev: ILogTargetDesc[], curr: ILogTargetDesc[]) => prev.concat(...curr), []);
  }

  protected matchRulesToLogger() {
    this.Rules = this.Options.rules.filter(r => {
      return globToRegexp(r.name).test(this.Name);
    });
  }

  protected write(err: Error | string, message: string | any[], level: LogLevel, ...args: any[]) {
    const lMsg = createLogMessageObject(err, message, level, this.Name, this.Variables, ...args);
    this.Targets.forEach(t => {
      if (level >= StrToLogLevel[t.rule.level]) {
        t.instance.write(lMsg);
      }
    });
  }


}

DI.register(Log).as("__logImplementation__");
DI.register((container: IContainer, ...args: any[]) => {

  if (!args || args.length === 0 || typeof args[0] !== "string") {
    throw new ResolveException(`invalid arguments for Log constructor (logger name)`)
  }

  const logName = args[0];

  if (Log.Loggers.has(logName)) {
    return Log.Loggers.get(logName);
  }

  return container.resolve("__logImplementation__", [...args]);
}).as(Log);