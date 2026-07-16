/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Configuration } from "@spinajs/configuration";
import { DI, IContainer, NewInstance } from "@spinajs/di";
import { ICommonTargetOptions, LogLevel, ILogOptions, ILogEntry, StrToLogLevel, createLogMessageObject, ILogRule, ITargetsOption, LogTarget, Log, LogFilter, ILogFilterOptions, readPersistedLevel } from "@spinajs/log-common";
import GlobToRegExp from "glob-to-regexp";
import { InvalidOperation, InvalidOption } from "@spinajs/exceptions";
import { InternalLoggerProxy } from "@spinajs/internal-logger";
import { captureCallsite } from "./callsite.js";
import _ from "lodash";

// Module-level cache of compiled glob->RegExp so a rule pattern is compiled ONCE
// process-wide, not once per (logger x rule) evaluation.
const GLOB_CACHE = new Map<string, RegExp>();
function globFor(pattern: string): RegExp {
  let re = GLOB_CACHE.get(pattern);
  if (!re) {
    // eslint-disable-next-line security/detect-non-literal-regexp
    re = GlobToRegExp(pattern);
    GLOB_CACHE.set(pattern, re);
  }
  return re;
}

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
  // composable per-logger filter pipeline, resolved from logger.filters ( plus a
  // prepended WhenRepeatedFilter for the legacy logger.whenRepeated option ).
  // Applied IN ORDER in write(); a null from any filter drops the entry.
  protected Filters: LogFilter[] = [];

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

    // Composable filter pipeline. Each configured filter is resolved by its DI
    // string name ( same mechanism as targets, see resolveLogTargets ) with its
    // own config entry passed as options, and applied IN ORDER in write().
    //
    // BACKWARD COMPAT: the legacy `logger.whenRepeated` option is mapped to a
    // WhenRepeatedFilter PREPENDED to the list so existing configs keep working.
    const configuredFilters: ILogFilterOptions[] = this.Options.filters ?? [];
    const filterSpecs: ILogFilterOptions[] = this.Options.whenRepeated ? [{ type: "WhenRepeatedFilter", ...this.Options.whenRepeated }, ...configuredFilters] : configuredFilters;
    this.Filters = filterSpecs.map((f) => DI.resolve<LogFilter>(f.type, [f]));

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
      // Composable filter pipeline - run the entry through each configured filter
      // IN ORDER. A filter returns the ( possibly modified ) entry to keep, or
      // null to DROP it, in which case dispatch is skipped entirely. Runs AFTER
      // the near-zero-cost level gate in the log methods so disabled levels never
      // even reach the filters.
      let filtered: ILogEntry | null = entry;
      for (const f of this.Filters) {
        filtered = f.apply(filtered);
        if (!filtered) {
          return Promise.resolve([]);
        }
      }
      const kept: ILogEntry = filtered;

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
    // BUG 2 fix: multiple matched rules can route to the SAME target. The old
    // code built one descriptor PER (rule, target) pair, so write() dispatched
    // to that target once per rule - duplicating output. Collapse to ONE
    // descriptor per target definition, keeping the MOST PERMISSIVE ( lowest )
    // rule level so the target receives an entry if ANY routing rule allows that
    // level, exactly once ( write() filters via kept.Level >= rule.level ). We
    // key by the target-config object ( a stable reference in Options.targets )
    // rather than the resolved instance so this is correct regardless of the
    // target's DI lifetime ( a @NewInstance target would otherwise still yield
    // one fresh instance per rule and never collapse ). Each unique target is
    // therefore resolved exactly ONCE.
    const byTarget = new Map<ITargetsOption, ILogRule>();

    for (const r of this.Rules) {
      const wantedNames = Array.isArray(r.target) ? r.target : [r.target];

      // Resolve the rule's target NAMES to definitions. Distinguish two cases:
      //  - a named target exists but is `enabled: false` -> intentionally not
      //    routed, skip it silently ( and do NOT instantiate it below ).
      //  - a name matches NO defined target at all -> misconfig ( BUG 3 ), throw.
      // So `namedButMissing` = wanted names with no matching def AT ALL; disabled
      // matches DO count as "the name exists" and are simply not collected.
      const namedButMissing = wantedNames.filter((n) => !this.Options.targets.some((t) => t.name === n));
      if (namedButMissing.length > 0) {
        throw new InvalidOption(`No target matching rule ${r.name} ( wanted target(s): ${namedButMissing.join(", ")} )`);
      }

      // EXCLUDE disabled targets before dedupe/resolve so they are never built.
      const found = this.Options.targets.filter((t) => {
        return wantedNames.includes(t.name) && t.enabled !== false;
      });

      for (const f of found) {
        const existing = byTarget.get(f);
        if (!existing || StrToLogLevel[r.level] < StrToLogLevel[existing.level]) {
          byTarget.set(f, r);
        }
      }
    }

    this.Targets = [...byTarget.entries()].map(([f, r]) => {
      return {
        instance: DI.resolve<LogTarget<ICommonTargetOptions>>(f.type, [f]),
        options: f,
        rule: r,
      };
    });
  }

  protected matchRulesToLogger() {
    // NLog-style ordered, ADDITIVE evaluation. Walk the rules IN CONFIG ORDER
    // and collect EVERY rule whose glob matches this logger ( so a logger matched
    // by both `*` and a specific rule routes to BOTH - de-duped by target in
    // resolveLogTargets ). A matched rule with `final: true` STOPS evaluation of
    // any LATER rules ( that final rule and all earlier matched rules still apply
    // ) - place a specific `final` rule before `*` to get this-rule-only routing.
    const matched: ILogRule[] = [];
    for (const r of this.Options.rules) {
      if (typeof r.name !== "string") {
        throw new InvalidOption(`Log rule name must be a string, got ${typeof r.name}`);
      }
      // Guard: an invalid level would leave StrToLogLevel[level] === undefined,
      // poisoning MinLevel ( Math.min(..., NaN) === NaN ) and the write() dispatch
      // gate, silently killing the logger. Schema validates config; this guards
      // programmatic / default rule paths too.
      if (!(r.level in StrToLogLevel)) {
        throw new InvalidOption(`Log rule ${r.name} has invalid level '${r.level}'`);
      }
      if (globFor(r.name).test(this.Name)) {
        matched.push(r);
        if (r.final) {
          break;
        }
      }
    }

    this.Rules = matched;
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
