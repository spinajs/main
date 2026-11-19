import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { redactPlan } from './plan.js';
import { SlowQuerySink } from './types.js';
import type { SlowQueryRecord } from './types.js';

/**
 * The default sink: one warning per slow query on the `orm-slow-query` logger. A log has a wider audience than a sink
 * that `CaptureBindings` is meant for, so the line never carries plan values or the text of an EXPLAIN error, which
 * can embed bound values. Postgres never writes a string in double quotes, so only its plans keep `"name"` tokens.
 */
@Injectable(SlowQuerySink)
export class LogSlowQuerySink extends SlowQuerySink {
  @Logger('orm-slow-query')
  protected Log: Log;

  public record(entry: SlowQueryRecord): void {
    this.Log.warn(
      {
        fingerprint: entry.fingerprint,
        durationMs: Math.round(entry.durationMs),
        connection: entry.connection,
        traceId: entry.traceId,
        spanId: entry.spanId,
        plan: entry.plan ? redactPlan(entry.plan, entry.plan.dialect === 'postgres').root : undefined,
        // an EXPLAIN error is recorded as `Class` or `Class: message`; the fixed reasons hold no colon
        planError: entry.planError?.split(':', 1)[0],
      },
      'slow query on ${connection} (${durationMs} ms): %s',
      entry.sql,
    );
  }
}
