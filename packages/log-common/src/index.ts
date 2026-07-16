import { Autoinject, Container, DI, SyncService } from "@spinajs/di";
import _ from "lodash";
import { format } from "./format.js";
import { applySerializers } from "./serializers.js";
import { persistLevel, clearPersistedLevel } from "./persistence.js";

export * from "./serializers.js";
export * from "./filters/filter.js";
export * from "./filters/whenRepeated.js";
export * from "./BatchQueue.js";
export * from "./persistence.js";

import type { IWhenRepeatedOptions } from "./filters/whenRepeated.js";
import type { ILogFilterOptions, LogFilter } from "./filters/filter.js";

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

/**
 * Sentinel level sitting one ABOVE {@link LogLevel.Security} ( SpinaJS's highest
 * real level ). Used by `Log.disableAll()` as the runtime override so even a
 * `security()` call is gated out - `isEnabled` compares numerically, so nothing
 * ever reaches it.
 */
export const SILENT_LEVEL = LogLevel.Security + 1;

/**
 * Normalises a level given either as a {@link LogLevel} number or a level name
 * ( "trace" | "debug" | ... ) to its numeric value. Single validation choke
 * point: an unknown name throws a clear error. Numbers pass straight through
 * ( so {@link SILENT_LEVEL } and other synthetic values are accepted ).
 */
export function normalizeLevel(level: LogLevel | string): LogLevel {
  if (typeof level === "number") {
    return level;
  }

  const resolved = (StrToLogLevel as Record<string, LogLevel>)[level];
  if (resolved === undefined) {
    throw new Error(`Invalid log level: ${level}`);
  }
  return resolved;
}

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

/**
 * Maps SpinaJS log levels onto the OpenTelemetry SeverityNumber scale ( 1..24 ),
 * so structured logs can be severity-ranked/filtered by any OTel-aware backend
 * ( Grafana, Datadog, Elastic, OTLP pipelines ). Anchored on the OTel bands:
 * TRACE 1-4, DEBUG 5-8, INFO 9-12, WARN 13-16, ERROR 17-20, FATAL 21-24.
 * Success sits in the INFO band ( above plain info ); Security is mapped to the
 * top of the FATAL band as SpinaJS's highest severity.
 */
export const LogLevelToSeverityNumber: Record<LogLevel, number> = {
  [LogLevel.Trace]: 1,
  [LogLevel.Debug]: 5,
  [LogLevel.Info]: 9,
  [LogLevel.Success]: 11,
  [LogLevel.Warn]: 13,
  [LogLevel.Error]: 17,
  [LogLevel.Fatal]: 21,
  [LogLevel.Security]: 23,
};

export interface ILogRule {
  name: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "security" | "success";
  target: string | string[];

  /**
   * Optional UPPER bound of the level window this rule routes ( inclusive ).
   * `level` is the lower bound; when `maxLevel` is set the rule only routes
   * entries whose level is in `[level, maxLevel]` ( eg. `level:"warn"` +
   * `maxLevel:"error"` routes warn/error but NOT fatal/security ). Defaults to
   * the highest level ( security ) so a plain min-only rule keeps working.
   */
  maxLevel?: ILogRule["level"];

  /**
   * Stop evaluating further rules for a logger once this matching rule is applied
   * ( NLog-style ). Earlier matched rules and this one still apply.
   */
  final?: boolean;
}

export interface ITargetsOption {
  name: string;
  type: string;
  options?: ICommonTargetOptions;

  /**
   * When `false` the target is NOT instantiated at all ( its class is never
   * constructed, so a disabled FileTarget never opens its file / starts timers ).
   * A rule referencing only disabled targets is silently skipped; a rule
   * referencing a target NAME that does not exist still throws. Default `true`.
   */
  enabled?: boolean;

  /**
   * Per-target filter pipeline, applied ONLY when writing to THIS target ( in
   * addition to the logger-level `filters` ). Each entry is `{ type, ...opts }`
   * where `type` is the DI string name of a {@link LogFilter }. Filters run IN
   * ORDER for this target; any returning null drops the entry for this target
   * only. Because filters may MUTATE the entry, the dispatcher clones the entry
   * per target before running them so mutation never bleeds across targets.
   */
  filters?: ILogFilterOptions[];
}

export interface ILogOptions {
  targets: ITargetsOption[];
  rules: ILogRule[];
  variables?: Record<string, unknown>;

  /**
   * Opt-in dedup filter that collapses identical repeated log entries. When set,
   * every logger gets its OWN WhenRepeatedFilter instance ( independent state ).
   * Default off.
   *
   * @deprecated prefer `filters: [{ type: "WhenRepeatedFilter", ... }]`. Kept
   * for backward compat - when set it is mapped to a prepended WhenRepeatedFilter.
   */
  whenRepeated?: IWhenRepeatedOptions;

  /**
   * Composable per-logger filter pipeline. Each entry is `{ type, ...opts }`
   * where `type` is the DI string name of a {@link LogFilter } ( eg.
   * "LevelFilter", "MatchFilter", "RateLimitFilter", "WhenRepeatedFilter" ).
   * Filters run IN ORDER inside `write()`; any filter returning null drops the
   * entry. Off ( empty ) by default.
   */
  filters?: ILogFilterOptions[];
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
     * path where the active log is stored ( relative to the `fs` provider base
     * path ). Variables are allowed to build the path eg. date / time etc.
     */
    path: string;

    /**
     * Directory ( relative to the `archiveFs` provider base path ) rotated /
     * archived files are stored in. Variables are allowed.
     *
     * When not set archives are stored in the same directory as the active log.
     */
    archivePath: string;

    /**
     * Name of the registered `@spinajs/fs` provider that stores the ACTIVE log
     * file. Defaults to `fs-log-default` ( registered automatically, base path
     * = process.cwd() ).
     */
    fs?: string;

    /**
     * Name of the registered `@spinajs/fs` provider archives are moved to.
     * Defaults to the same provider as `fs`.
     */
    archiveFs?: string;

    /**
     * Class name of the LogArchiveStrategy that decides WHEN to rotate.
     * Default is `SizeLogArchiveStrategy` ( interval size check ). Use
     * `CronLogArchiveStrategy` together with `rotate` for scheduled rotation.
     */
    archiveStrategy?: string;

    /**
     * List of LogRetentionStrategy class names applied in order after each
     * rotation. Compose eg. count + age. Default is [`CountLogRetentionStrategy`].
     */
    retentionStrategies?: string[];

    /**
     * Maximum active log file size in bytes. When exceeded the file is rotated
     * to the archive by `SizeLogArchiveStrategy`. Default is 1mb.
     */
    maxSize: number;

    /**
     * Compress ( zip ) the archived file when moved to the archive.
     *
     * Default is false.
     */
    compress: boolean;

    /**
     * Cron expression used by `CronLogArchiveStrategy` to rotate the log
     * ( 6-field with seconds supported, eg. '0 0 1 * * *' = 1am daily ).
     * Required when that strategy is selected.
     *
     * Default is not set.
     */
    rotate: string;

    /**
     * Max internal message buffer size before writing to file. Higher means
     * fewer disk writes. Defaults to 100 messages.
     */
    maxBufferSize: number;

    /**
     * Hard cap on the number of buffered messages held in memory. When exceeded
     * ( eg. the fs sink is down and appends keep failing so the batch is
     * prepended back ) the OLDEST buffered messages are dropped so memory stays
     * bounded. Defaults to 100000.
     */
    maxQueueSize: number;

    /**
     * How many archive files to keep before deletion, used by
     * `CountLogRetentionStrategy`. Oldest by modification time are deleted.
     * Default is 5.
     */
    maxArchiveFiles: number;

    /**
     * Max archive age in seconds, used by `AgeLogRetentionStrategy`. Archives
     * older than this are deleted. Default is 7 days.
     */
    maxAge?: number;

    /**
     * Interval in seconds at which `SizeLogArchiveStrategy` checks whether the
     * active log needs rotating. Default is 60 seconds.
     */
    archiveInterval: number;

    /**
     * Periodic flush tick in milliseconds. A partially filled buffer is flushed
     * at least this often so messages are not held indefinitely. Default 1000ms.
     */
    flushInterval?: number;
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
          layout: "${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})",
        }),
        options
      );
    } else {
      this.Options = {
        enabled: true,
        layout: "${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})",
      } as T;
    }
  }

  /**
   * Write ( accept ) a single log entry.
   *
   * ## Rejection contract
   *
   * `write()` MAY reject to signal that the entry was NOT accepted / delivered.
   * Self-healing targets ( File / Loki / OTLP ) RESOLVE because they own their
   * reliability ( they buffer, requeue and retry internally ); wrappers like
   * {@link RetryingTarget} / {@link FallbackGroupTarget} act on a rejection for
   * targets that surface failure ( console / custom / strict ). A resolved
   * write means "accepted for delivery", not necessarily "durably delivered".
   */
  public abstract write(data: ILogEntry): void;

  /**
   * Drop-hook. Set by a wrapper ( eg. {@link FallbackGroupTarget} ) to receive
   * entries this target GAVE UP on ( buffer overflow or a non-retryable delivery
   * failure ), so a durable fallback can catch EXACTLY what was not delivered —
   * no duplicates. `null` ( the default ) means nobody is listening and dropped
   * entries are simply discarded, as before.
   */
  public OnDropped: ((entry: ILogEntry) => void) | null = null;

  /** Flush any buffered entries to the underlying sink. Default no-op; buffered targets override. */
  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export interface ILogTargetDesc {
  instance: LogTarget<ICommonTargetOptions>;
  options?: ITargetsOption;

  /**
   * Representative rule for this target ( the one with the LOWEST min level ).
   * Kept for the "no target" error message and back-compat; actual dispatch uses
   * {@link ranges }, not this rule's single level.
   */
  rule: ILogRule;

  /**
   * Union of level WINDOWS routing to this target. Several rules can route to the
   * same target with DIFFERENT `[level, maxLevel]` windows; dispatch tests
   * membership in ANY of them. A plain min-only rule yields `[min, Security]`, so
   * behavior is unchanged for existing configs.
   */
  ranges: { min: LogLevel; max: LogLevel }[];

  /**
   * Resolved per-target filters ( from the target def's `filters` ), applied in
   * `write()` after the logger-level pipeline, for THIS target only. `@NewInstance`
   * so each logger's use of the target gets its own filter instances / state.
   */
  filters?: LogFilter[];
}

export function createLogMessageObject(err: Error | string, message: string | any[], level: LogLevel, logger: string, variables: any, ...args: any[]): ILogEntry {
  const sMsg = err instanceof Error || !err ? (message as string) : err;
  const tMsg = args.length !== 0 ? format(sMsg, ...args) : sMsg;
  const lName = logger ?? message;

  // Ambient async-context fields ( lowest precedence, must never throw ). The
  // computed core fields below and any explicit per-call / logger `variables`
  // OVERRIDE these — ambient context only FILLS IN fields nobody else set.
  let ctx: Record<string, unknown> = {};
  try {
    ctx = logContextProvider() ?? {};
  } catch {
    ctx = {};
  }

  const theVars = {
    ...ctx,
    error: err instanceof Error ? err : undefined,
    level: LogLevelStrings[`${level}`].toUpperCase(),
    logger: lName,
    message: tMsg,
    ...variables,
  };

  applySerializers(theVars);

  return {
    Level: level,
    Variables: theVars,
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

  /**
   * Lowest level any of this logger's targets accepts ( the MIN across its
   * matched rules ). Set by FrameworkLogger.resolve(); default Trace = allow
   * all. A call below this level would be dropped by every target anyway, so the
   * per-method guard can safely short-circuit on it.
   */
  protected MinLevel: LogLevel = LogLevel.Trace;

  /**
   * Runtime level override ( loglevel-style ). `null` means "no override, use
   * MinLevel". Set via setLevel/enableAll/disableAll, cleared via resetLevel.
   */
  protected LevelOverride: LogLevel | null = null;

  /** Effective minimum level: the runtime override if set, otherwise MinLevel. */
  public getLevel(): LogLevel {
    return this.LevelOverride ?? this.MinLevel;
  }

  /** True when a call at `level` should be emitted given the effective level. */
  protected isEnabled(level: LogLevel): boolean {
    return level >= this.getLevel();
  }

  /**
   * Set a runtime level override. Accepts a {@link LogLevel} or a level name.
   * When `persist` ( default true ) the choice is stored so it survives a
   * browser reload ( no-op on Node ).
   */
  public setLevel(level: LogLevel | keyof typeof StrToLogLevel, persist = true): void {
    this.LevelOverride = normalizeLevel(level);
    if (persist) {
      persistLevel(this.Name, this.LevelOverride);
    }
  }

  /**
   * Set the override ONLY if nothing is currently applied ( loglevel semantics:
   * a default must never clobber a user's explicit / persisted choice ). Never
   * persists.
   */
  public setDefaultLevel(level: LogLevel | keyof typeof StrToLogLevel): void {
    if (this.LevelOverride === null) {
      this.LevelOverride = normalizeLevel(level);
    }
  }

  /** Drop the runtime override ( back to MinLevel ) and clear any persisted value. */
  public resetLevel(): void {
    this.LevelOverride = null;
    clearPersistedLevel(this.Name);
  }

  /** Enable every level ( Trace and up ). */
  public enableAll(persist = true): void {
    this.setLevel(LogLevel.Trace, persist);
  }

  /**
   * Disable every level - even {@link LogLevel.Security} - by raising the
   * override to {@link SILENT_LEVEL} ( one above Security ).
   */
  public disableAll(persist = true): void {
    this.setLevel(SILENT_LEVEL, persist);
  }

  /**
   * Force-drain THIS logger's targets' buffers ( eg. File / Loki / OTLP batch
   * queues ) so buffered entries are written out. Does NOT close / dispose the
   * target - handle & timer teardown remains the DI container's job. Calling
   * `forceFlush()` on a non-buffered target is a harmless no-op. Guarded so a
   * logger that failed to resolve ( no `Targets` ) is a safe no-op.
   */
  public flush(): Promise<void> {
    if (!this.Targets || this.Targets.length === 0) {
      return Promise.resolve();
    }
    return Promise.allSettled(this.Targets.map((t) => t.instance.forceFlush())).then(() => undefined);
  }

  /** Flush every registered logger ( best-effort; never rejects ). */
  public static flushAll(): Promise<void> {
    return Promise.allSettled([...Log.Loggers.values()].map((l) => l.flush())).then(() => undefined);
  }

  public static clearLoggers() {
    // Flush buffered entries out BEFORE tearing loggers down so File / Loki /
    // OTLP data is not lost when teardown does not go through DI container
    // disposal of the target singletons.
    return Log.flushAll()
      .then(() => Promise.all([...Log.Loggers.values()].map((l) => l.dispose())))
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

    const timer = this.Timers.get(name);
    if (!timer) {
      return 0;
    }

    const cTime = new Date();
    const diff = cTime.getTime() - timer.getTime();

    this.Timers.delete(name);

    return diff;
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
  public abstract trace(fields: object, message?: string, ...args: any[]): void;
  public abstract trace(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract debug(message: string, ...args: any[]): void;
  public abstract debug(err: Error, message: string, ...args: any[]): void;
  public abstract debug(fields: object, message?: string, ...args: any[]): void;
  public abstract debug(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract info(message: string, ...args: any[]): void;
  public abstract info(err: Error, message: string, ...args: any[]): void;
  public abstract info(fields: object, message?: string, ...args: any[]): void;
  public abstract info(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract warn(message: string, ...args: any[]): void;
  public abstract warn(err: Error, message: string, ...args: any[]): void;
  public abstract warn(fields: object, message?: string, ...args: any[]): void;
  public abstract warn(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract error(message: string, ...args: any[]): void;
  public abstract error(err: Error, message: string, ...args: any[]): void;
  public abstract error(fields: object, message?: string, ...args: any[]): void;
  public abstract error(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract fatal(message: string, ...args: any[]): void;
  public abstract fatal(err: Error, message: string, ...args: any[]): void;
  public abstract fatal(fields: object, message?: string, ...args: any[]): void;
  public abstract fatal(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract security(message: string, ...args: any[]): void;
  public abstract security(err: Error, message: string, ...args: any[]): void;
  public abstract security(fields: object, message?: string, ...args: any[]): void;
  public abstract security(err: Error | string, message: string | any[], ...args: any[]): void;

  public abstract success(message: string, ...args: any[]): void;
  public abstract success(err: Error, message: string, ...args: any[]): void;
  public abstract success(fields: object, message?: string, ...args: any[]): void;
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
        const found = allLoggers!.find((l) => l.Name === name);

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

/**
 * Ambient log-context provider seam. A Node-side consumer ( @spinajs/log's
 * LogContext ) registers a function returning the current async-context store;
 * `createLogMessageObject` merges its result at LOWEST precedence so every log
 * entry inherits ambient fields ( eg. requestId ) without threading them by hand.
 *
 * Kept here ( not in @spinajs/log ) so the seam is browser-safe: log-common must
 * stay free of `node:async_hooks`. The default provider returns an empty object;
 * the browser build wires a synchronous fallback instead.
 */
let logContextProvider: () => Record<string, unknown> = () => ({});

/**
 * Registers the ambient log-context provider. See {@link logContextProvider}.
 */
export function setLogContextProvider(fn: () => Record<string, unknown>): void {
  logContextProvider = fn;
}

