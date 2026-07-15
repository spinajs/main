/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Configuration } from "@spinajs/configuration";
import { DI, IContainer, NewInstance } from "@spinajs/di";
import { ICommonTargetOptions, LogLevel, ILogOptions, ILogEntry, StrToLogLevel, createLogMessageObject, ILogTargetDesc, LogTarget, Log, WhenRepeatedFilter, readPersistedLevel } from "@spinajs/log-common";
import GlobToRegExp from "glob-to-regexp";
import { InvalidOperation, InvalidOption } from "@spinajs/exceptions";
import { InternalLoggerProxy } from "@spinajs/internal-logger";
import { captureCallsite } from "./callsite.js";
import _ from "lodash";

function wrapWrite(this: Log, level: LogLevel) {
  return (err: Error | string | object, message: string | any[], ...args: any[]) => {
    // Zero-cost gating: only parse a caller frame ( which constructs an Error )
    // when some target's layout references ${callsite}. Otherwise `vars` is just
    // this.Variables and no Error is ever built - mirroring NLog's StackTraceUsage.
    const extra = (this as FrameworkLogger).CaptureCallsite ? { callsite: captureCallsite() } : undefined;
    const vars = extra ? { ...this.Variables, ...extra } : this.Variables;

    if (err instanceof Error) {
      return this.write(createLogMessageObject(err, message, level, this.Name, vars, ...args));
    } else if (err !== null && typeof err === "object" && !Array.isArray(err)) {
      // merging-object form: `err` is a bag of structured fields, `message` is the
      // format string, the rest are printf args. Fields are spread into Variables
      // ( so a nested `error` key still runs the serializer ).
      const fields = err as Record<string, unknown>;
      const fmt = typeof message === "string" ? message : "";
      return this.write(createLogMessageObject(null as any, fmt, level, this.Name, { ...vars, ...fields }, ...args));
    } else {
      const sErr = err as string;
      if (message) {
        return this.write(createLogMessageObject(sErr, null as any, level, this.Name, vars, ...[message, ...args]));
      } else {
        return this.write(createLogMessageObject(sErr, null as any, level, this.Name, vars, ...args));
      }
    }
  };
}

/**
 * Default log implementation interface. Taken from bunyan. Feel free to implement own.
 */
@NewInstance()
export class FrameworkLogger extends Log {
  // per-logger dedup filter, only present when logger.whenRepeated is configured
  protected RepeatFilter?: WhenRepeatedFilter;

  // Set in resolve() when some target's layout references ${callsite}. Gates the
  // caller-frame capture in wrapWrite so logging stays zero-cost otherwise.
  public CaptureCallsite = false;

  constructor(public Name: string, variables?: Record<string, unknown>, protected Parent?: Log) {
    super();

    this.Variables = variables ?? {};
  }

  public resolve(): void {
    const config = this.Container.get(Configuration);

    if (!config) {
      throw new Error(`Configuration module is not avaible. Please resolve configuration module before any logging can occur`);
    }

    // read the logger config and default per-subkey - the `logger` key always
    // exists now ( the package ships logger.file defaults ), so a whole-object
    // fallback would never apply. targets / rules still fall back individually.
    const configured = config.get<Partial<ILogOptions>>("logger", {});
    this.Options = {
      ...configured,
      targets: configured.targets ?? [
        {
          name: "Console",
          type: "ConsoleTarget",
        },
      ],
      rules: configured.rules ?? [{ name: "*", level: "trace", target: "Console" }],
    } as ILogOptions;

    // make unique targets
    // some modules may add same logger so we have multiple console loggers etc.
    this.Options.targets = _.uniqWith(this.Options.targets, (a, b) => {
      return a.name === b.name && a.type === b.type;
    });

    // opt-in dedup. NOTE: this is currently GLOBAL - every logger reads the same
    // `logger.whenRepeated` config key, so setting it enables dedup for ALL
    // loggers ( each with its OWN independent per-logger filter state ). That is
    // the intended minimal surface; per-rule granularity arrives with the full
    // filter-pipeline phase.
    if (this.Options.whenRepeated) {
      this.RepeatFilter = new WhenRepeatedFilter(this.Options.whenRepeated);
    }

    this.matchRulesToLogger();
    this.resolveLogTargets();

    // Gate ${callsite} capture: only turn it on when some resolved target's
    // layout actually references it. When off, wrapWrite never builds an Error.
    this.CaptureCallsite = this.Targets.some((t) => typeof t.instance?.Options?.layout === "string" && /\$\{callsite/.test(t.instance.Options.layout));

    // MinLevel = the lowest level any matched rule ( ie. any target ) accepts.
    // A call below this level would be dropped by every target, so the per-method
    // isEnabled() guard can short-circuit on it without changing output.
    this.MinLevel = this.Rules.length ? Math.min(...this.Rules.map((r) => StrToLogLevel[r.level])) : LogLevel.Trace;

    // Load any browser-persisted runtime override ( no-op / undefined on Node ).
    const persisted = readPersistedLevel(this.Name);
    if (persisted !== undefined) {
      this.LevelOverride = persisted;
    }

    super.resolve();

    Log.Loggers.set(this.Name, this);
  }

  public trace(message: string, ...args: any[]): void;
  public trace(err: Error, message: string, ...args: any[]): void;
  public trace(fields: object, message?: string, ...args: any[]): void;
  public trace(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    if (!this.isEnabled(LogLevel.Trace)) return;
    wrapWrite.apply(this, [LogLevel.Trace])(err, message, ...args);
  }

  public debug(message: string, ...args: any[]): void;
  public debug(err: Error, message: string, ...args: any[]): void;
  public debug(fields: object, message?: string, ...args: any[]): void;
  public debug(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    if (!this.isEnabled(LogLevel.Debug)) return;
    wrapWrite.apply(this, [LogLevel.Debug])(err, message, ...args);
  }

  public info(message: string, ...args: any[]): void;
  public info(err: Error, message: string, ...args: any[]): void;
  public info(fields: object, message?: string, ...args: any[]): void;
  public info(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    if (!this.isEnabled(LogLevel.Info)) return;
    wrapWrite.apply(this, [LogLevel.Info])(err, message, ...args);
  }

  public warn(message: string, ...args: any[]): void;
  public warn(err: Error, message: string, ...args: any[]): void;
  public warn(fields: object, message?: string, ...args: any[]): void;
  public warn(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    if (!this.isEnabled(LogLevel.Warn)) return;
    wrapWrite.apply(this, [LogLevel.Warn])(err, message, ...args);
  }

  public error(message: string, ...args: any[]): void;
  public error(err: Error, message: string, ...args: any[]): void;
  public error(fields: object, message?: string, ...args: any[]): void;
  public error(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    if (!this.isEnabled(LogLevel.Error)) return;
    wrapWrite.apply(this, [LogLevel.Error])(err, message, ...args);
  }

  public fatal(message: string, ...args: any[]): void;
  public fatal(err: Error, message: string, ...args: any[]): void;
  public fatal(fields: object, message?: string, ...args: any[]): void;
  public fatal(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    if (!this.isEnabled(LogLevel.Fatal)) return;
    wrapWrite.apply(this, [LogLevel.Fatal])(err, message, ...args);
  }

  public security(message: string, ...args: any[]): void;
  public security(err: Error, message: string, ...args: any[]): void;
  public security(fields: object, message?: string, ...args: any[]): void;
  public security(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    if (!this.isEnabled(LogLevel.Security)) return;
    wrapWrite.apply(this, [LogLevel.Security])(err, message, ...args);
  }

  public success(message: string, ...args: any[]): void;
  public success(err: Error, message: string, ...args: any[]): void;
  public success(fields: object, message?: string, ...args: any[]): void;
  public success(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    if (!this.isEnabled(LogLevel.Success)) return;
    wrapWrite.apply(this, [LogLevel.Success])(err, message, ...args);
  }

  public write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    if (entry.Variables.logger === this.Name) {
      // opt-in dedup - collapse identical repeated entries. `filter` returns the
      // ( possibly (xN)-annotated ) entry to emit, or null to suppress it.
      let kept: ILogEntry = entry;
      if (this.RepeatFilter) {
        const filtered = this.RepeatFilter.filter(entry);
        if (!filtered) {
          return Promise.resolve([]);
        }
        kept = filtered;
      }

      return Promise.allSettled(

        this.Targets.filter((t) => kept.Level >= StrToLogLevel[t.rule.level]).map((t) => {
          if (!t.instance) {
            throw new InvalidOperation(`Target ${t.rule.target} for rule ${t.rule.name} not exists`);
          }

          return t.instance.write(kept);
        })
      );
    }
    return Promise.resolve([]);
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
    const matchingRules = this.Options.rules.filter((r) => {
      if (typeof r.name !== "string") {
        throw new InvalidOption(`Log rule name must be a string, got ${typeof r.name}`);
      }

      // eslint-disable-next-line security/detect-non-literal-regexp
      const g = GlobToRegExp(r.name);
      return g.test(this.Name);
    });

    // Check if there are any specific (non-wildcard) rules
    const hasSpecificRule = matchingRules.some((r) => r.name !== '*');

    // If specific rules exist, exclude wildcard rules
    this.Rules = hasSpecificRule 
      ? matchingRules.filter((r) => r.name !== '*')
      : matchingRules;
  }
}

const logFactoryFunction = (container: IContainer, logName: string) => {
  if (Log.Loggers.has(logName)) {
    return Log.Loggers.get(logName);
  }

  if (!DI.has(Configuration)) {
    if (Log.InternalLoggers.has(logName)) {
      return Log.InternalLoggers.get(logName);
    }

    const internalLogger = container.resolve(InternalLoggerProxy, [logName]);
    Log.InternalLoggers.set(logName, internalLogger);
    return internalLogger;
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
DI.register(FrameworkLogger).as("__logImplementation__");
