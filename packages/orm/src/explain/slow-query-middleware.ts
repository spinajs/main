import { DI, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { LruTtlCache, settleWithin, singleFlight, SystemClock, TaskTracker } from '@spinajs/util';
import type { Clock } from '@spinajs/util';
import { QueryContext, QueryMiddleware } from '../interfaces.js';
import type { QueryBuilder } from '../builders.js';
import type { OrmDriver } from '../driver.js';
import { executedStatements, setStatementRecording } from './execution.js';
import type { ExecutedStatement } from './execution.js';
import { fingerprint, sanitizeSql } from './fingerprint.js';
import { explainOptions } from './options.js';
import { redactPlan } from './plan.js';
import { isExplainable } from './statement.js';
import { SlowQuerySink } from './types.js';
import type { ExplainOptions, QueryPlan, SlowQueryRecord } from './types.js';

const MINUTE_MS = 60_000;
const MAX_REMEMBERED_FINGERPRINTS = 1000;

/** Captures waiting for their turn or for an EXPLAIN; a slow statement beyond this is counted, not recorded. */
export const MAX_PENDING_SLOW_QUERY_CAPTURES = 100;

/** How long a capture waits for one sink before it logs the sink as timed out and lets the capture end. */
export const SLOW_QUERY_SINK_TIMEOUT_MS = 5000;

interface PlanOutcome {
  plan?: QueryPlan;
  planError?: string;
}

/** Driver errors embed the statement's bindings, so their text is kept only where bindings are. */
function describeError(err: unknown, withMessage: boolean): string {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  return withMessage && err instanceof Error ? `${name}: ${err.message}` : name;
}

/** A plan belongs to one connection, and one kept with values must not reach a record made without them. */
function planKey(record: SlowQueryRecord, options: ExplainOptions): string {
  return JSON.stringify([record.connection, options.CaptureBindings, record.fingerprint]);
}

/**
 * Records statements slower than `db.Explain.SlowQueryMs` and plans single reads. The duration is
 * the driver's own measurement: the before→after window of a middleware also holds the after hooks
 * of every middleware ordered before it.
 */
@Injectable(QueryMiddleware)
export class SlowQueryMiddleware extends QueryMiddleware {
  public order = 2000;

  @Logger('orm-slow-query')
  protected Log: Log;

  /** The clock of the plan cache and the rate window. */
  public clock: Clock = new SystemClock();

  private readonly remembered = new LruTtlCache<string, PlanOutcome>({ maxEntries: MAX_REMEMBERED_FINGERPRINTS, ttlMs: MINUTE_MS, clock: { now: () => this.clock.now() } });
  private readonly planning = new Map<string, Promise<PlanOutcome>>();
  private readonly captures = new TaskTracker((err) => this.Log.warn({ error: err }, 'slow query capture failed'));
  private rateWindow = { start: Number.NEGATIVE_INFINITY, count: 0 };
  private dropped = 0;
  /** A timed-out call is not cancelled, so a stalled sink would otherwise collect one unsettled call per slow statement. */
  private readonly unsettled = new WeakMap<SlowQuerySink, number>();
  private skipped = 0;
  private options: ExplainOptions | undefined;

  public afterQueryCreation(): void {}

  /** The driver must know whether to keep the statement before it runs, so the configuration is read here, once. */
  public beforeQueryExecution(): void {
    this.current();
  }

  public afterQueryExecution(query: QueryBuilder): void {
    const options = this.current();
    if (!options.Enabled) {
      return;
    }

    const statements = executedStatements(query);
    const durationMs = statements.reduce((sum, s) => sum + s.durationMs, 0);
    if (statements.length === 0 || durationMs < options.SlowQueryMs) {
      return;
    }

    if (this.captures.size >= MAX_PENDING_SLOW_QUERY_CAPTURES) {
      this.dropped++;
      return;
    }

    const at = new Date();
    const context = query.QueryContext;
    this.captures.defer(() => this.capture(context, statements, durationMs, at, options).finally(() => this.reportDropped()));
  }

  /** Resolves when every deferred capture has finished. */
  public idle(): Promise<void> {
    return this.captures.drain();
  }

  /** Re-reads `db.Explain`, for tests and tooling that change it after the first query. A remembered plan was made under the old options, so none is kept, and `MaxPerMinute` counts from now. */
  public reload(): void {
    this.options = undefined;
    this.remembered.clear();
    this.rateWindow = { start: Number.NEGATIVE_INFINITY, count: 0 };
    this.current();
  }

  private current(): ExplainOptions {
    if (this.options === undefined) {
      this.options = explainOptions();
      setStatementRecording(this.options.Enabled);
    }

    return this.options;
  }

  private async capture(context: QueryContext, statements: readonly ExecutedStatement[], durationMs: number, at: Date, options: ExplainOptions): Promise<void> {
    const first = statements[0];
    const driver = first.driver;
    const ansi = driver.ansiQuotedIdentifiers();
    const sql = statements.map((s) => s.sql).join(';\n');
    const record: SlowQueryRecord = {
      fingerprint: fingerprint(sql, ansi),
      sql: sanitizeSql(sql, ansi),
      driver: String(driver.Options.Driver),
      connection: String(driver.Options.Name),
      durationMs,
      at,
      ...(first.traceId ? { traceId: first.traceId, spanId: first.spanId } : {}),
      ...(options.CaptureBindings ? { bindings: statements.flatMap((s) => s.bindings) } : {}),
    };

    if (statements.length === 1 && context === QueryContext.Select && (!first.rawSql || isExplainable(first.sql))) {
      Object.assign(record, await this.planFor(driver, planKey(record, options), first, options));
    }

    await this.publish(record);
  }

  /** Reported when a capture ends: captures that start later may never come. */
  private reportDropped(): void {
    if (this.dropped > 0) {
      this.Log.warn({ dropped: this.dropped, limit: MAX_PENDING_SLOW_QUERY_CAPTURES }, '${dropped} slow queries were not recorded: more than ${limit} captures were pending');
      this.dropped = 0;
    }

    if (this.skipped > 0) {
      this.Log.warn({ skipped: this.skipped, limit: MAX_PENDING_SLOW_QUERY_CAPTURES }, '${skipped} slow query records were not given to a sink that had ${limit} calls unsettled');
      this.skipped = 0;
    }
  }

  private planFor(driver: OrmDriver, key: string, statement: ExecutedStatement, options: ExplainOptions): Promise<PlanOutcome> {
    const known = this.remembered.get(key);
    return known ? Promise.resolve(known) : singleFlight(this.planning, key, () => this.explain(driver, key, statement, options));
  }

  private async explain(driver: OrmDriver, key: string, statement: ExecutedStatement, options: ExplainOptions): Promise<PlanOutcome> {
    if (typeof driver.explain !== 'function') {
      return { planError: `driver ${String(driver.Options.Driver)} cannot explain` };
    }

    if (!this.takeExplainSlot(options.MaxPerMinute)) {
      return { planError: 'explain rate limit reached' };
    }

    let outcome: PlanOutcome;
    try {
      const plan = await driver.explain(statement.sql, statement.bindings, statement.rawSql);
      outcome = { plan: options.CaptureBindings ? plan : redactPlan(plan, driver.ansiQuotedIdentifiers()) };
    } catch (err) {
      outcome = { planError: describeError(err, options.CaptureBindings) };
    }

    this.remembered.set(key, outcome);
    return outcome;
  }

  private takeExplainSlot(maxPerMinute: number): boolean {
    const now = this.clock.now().getTime();
    if (now - this.rateWindow.start >= MINUTE_MS) {
      this.rateWindow = { start: now, count: 0 };
    }

    if (this.rateWindow.count >= maxPerMinute) {
      return false;
    }

    this.rateWindow.count++;
    return true;
  }

  private async publish(record: SlowQueryRecord): Promise<void> {
    await Promise.allSettled(DI.resolve(Array.ofType(SlowQuerySink)).map((sink) => this.deliver(sink, record)));
  }

  /** A sink that never settles would hold its capture's pending slot for good, and past the limit stop every capture. */
  private async deliver(sink: SlowQuerySink, record: SlowQueryRecord): Promise<void> {
    const inFlight = this.unsettled.get(sink) ?? 0;
    if (inFlight >= MAX_PENDING_SLOW_QUERY_CAPTURES) {
      this.skipped++;
      return;
    }
    this.unsettled.set(sink, inFlight + 1);

    const call = Promise.resolve()
      .then(() => sink.record(record))
      .finally(() => this.unsettled.set(sink, (this.unsettled.get(sink) ?? 1) - 1));
    const delivered = await settleWithin(call, SLOW_QUERY_SINK_TIMEOUT_MS);
    if (delivered.status === 'timeout') {
      this.Log.warn({ sink: sink.constructor.name, timeoutMs: SLOW_QUERY_SINK_TIMEOUT_MS }, 'slow query sink ${sink} timed out after ${timeoutMs} ms');
    } else if (delivered.status === 'rejected') {
      this.Log.warn({ error: delivered.reason, sink: sink.constructor.name }, 'slow query sink ${sink} failed');
    }
  }
}
