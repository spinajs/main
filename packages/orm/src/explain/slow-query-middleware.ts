import { DI, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
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

  private readonly remembered = new Map<string, { at: number; outcome: PlanOutcome }>();
  private readonly planning = new Map<string, Promise<PlanOutcome>>();
  private readonly pending = new Set<Promise<void>>();
  private windowStart = Number.NEGATIVE_INFINITY;
  private windowCount = 0;
  private dropped = 0;
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

    if (this.pending.size >= MAX_PENDING_SLOW_QUERY_CAPTURES) {
      this.dropped++;
      return;
    }

    const at = new Date();
    const context = query.QueryContext;
    this.defer(() => this.capture(context, statements, durationMs, at, options));
  }

  /** Resolves when every deferred capture has finished. */
  public async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }

  /** Re-reads `db.Explain`, for tests and tooling that change it after the first query. A remembered plan was made under the old options, so none is kept. */
  public reload(): void {
    this.options = undefined;
    this.remembered.clear();
    this.current();
  }

  /** The clock of the plan cache and the rate window. */
  public now(): number {
    return Date.now();
  }

  private current(): ExplainOptions {
    if (this.options === undefined) {
      this.options = explainOptions();
      setStatementRecording(this.options.Enabled);
    }

    return this.options;
  }

  private defer(work: () => Promise<void>): void {
    const job: Promise<void> = this.afterResult(work).finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  private async afterResult(work: () => Promise<void>): Promise<void> {
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await work();
    } catch (err) {
      this.Log.warn({ error: err }, 'slow query capture failed');
    }
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

    if (statements.length === 1 && context === QueryContext.Select && isExplainable(first.sql)) {
      Object.assign(record, await this.planFor(driver, planKey(record, options), first, options));
    }

    if (this.dropped > 0) {
      this.Log.warn({ dropped: this.dropped, limit: MAX_PENDING_SLOW_QUERY_CAPTURES }, '${dropped} slow queries were not recorded: more than ${limit} captures were pending');
      this.dropped = 0;
    }

    await this.publish(record);
  }

  private planFor(driver: OrmDriver, key: string, statement: ExecutedStatement, options: ExplainOptions): Promise<PlanOutcome> {
    const now = this.now();
    const known = this.remembered.get(key);
    if (known && now - known.at < MINUTE_MS) {
      return Promise.resolve(known.outcome);
    }

    const running = this.planning.get(key);
    if (running) {
      return running;
    }

    const started = this.explain(driver, key, statement, options, now).finally(() => this.planning.delete(key));
    this.planning.set(key, started);
    return started;
  }

  private async explain(driver: OrmDriver, key: string, statement: ExecutedStatement, options: ExplainOptions, now: number): Promise<PlanOutcome> {
    if (typeof driver.explain !== 'function') {
      return { planError: `driver ${String(driver.Options.Driver)} cannot explain` };
    }

    if (!this.takeExplainSlot(now, options.MaxPerMinute)) {
      return { planError: 'explain rate limit reached' };
    }

    let outcome: PlanOutcome;
    try {
      const plan = await driver.explain(statement.sql, statement.bindings);
      outcome = { plan: options.CaptureBindings ? plan : redactPlan(plan, driver.ansiQuotedIdentifiers()) };
    } catch (err) {
      outcome = { planError: describeError(err, options.CaptureBindings) };
    }

    this.remember(key, now, outcome);
    return outcome;
  }

  private takeExplainSlot(now: number, maxPerMinute: number): boolean {
    if (now - this.windowStart >= MINUTE_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }

    if (this.windowCount >= maxPerMinute) {
      return false;
    }

    this.windowCount++;
    return true;
  }

  private remember(key: string, at: number, outcome: PlanOutcome): void {
    if (this.remembered.size >= MAX_REMEMBERED_FINGERPRINTS) {
      const oldest = this.remembered.keys().next();
      if (!oldest.done) {
        this.remembered.delete(oldest.value);
      }
    }

    this.remembered.delete(key);
    this.remembered.set(key, { at, outcome });
  }

  private async publish(record: SlowQueryRecord): Promise<void> {
    for (const sink of DI.resolve(Array.ofType(SlowQuerySink))) {
      try {
        await sink.record(record);
      } catch (err) {
        this.Log.warn({ error: err, sink: sink.constructor.name }, 'slow query sink ${sink} failed');
      }
    }
  }
}
