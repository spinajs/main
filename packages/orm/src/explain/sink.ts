import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { SlowQuerySink } from './types.js';
import type { SlowQueryRecord } from './types.js';

/** The default sink: one warning per slow query on the `orm-slow-query` logger. */
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
        plan: entry.plan?.root,
        planError: entry.planError,
      },
      'slow query on ${connection} (${durationMs} ms): %s',
      entry.sql,
    );
  }
}
