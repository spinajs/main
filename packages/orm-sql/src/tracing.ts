import { isSpanContextValid, SpanKind } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { fingerprint, QueryContext, sanitizeSql } from '@spinajs/orm';
import { SpinaAttr, markSpanErrorType, tracer } from '@spinajs/tracing';

export const MAX_QUERY_TEXT = 2048;

// OTel's names for the systems these driver tokens connect to; any other token is reported without its prefix.
const DB_SYSTEMS = new Map<string, string>([
  ['orm-driver-sqlite', 'sqlite'],
  ['orm-driver-postgres', 'postgresql'],
  ['orm-driver-pglite', 'postgresql'],
  ['orm-driver-mysql', 'mysql'],
  ['orm-driver-mysql-ssh', 'mysql'],
  ['orm-driver-mssql', 'microsoft.sql_server'],
]);

const OPERATION_OF_CONTEXT = new Map<QueryContext, string>([
  [QueryContext.Select, 'SELECT'],
  [QueryContext.Insert, 'INSERT'],
  [QueryContext.InsertReturning, 'INSERT'],
  [QueryContext.Upsert, 'INSERT'],
  [QueryContext.Update, 'UPDATE'],
  [QueryContext.Delete, 'DELETE'],
]);

const LEADING_KEYWORD = /^[\s(]*([A-Za-z]+)/;

export interface StatementTarget {
  driver: string;
  connection: string;
  context: QueryContext;
  table: string | undefined;
  ansiQuotedIdentifiers: boolean;
}

export function dbSystemName(driverToken: string): string {
  return DB_SYSTEMS.get(driverToken) ?? driverToken.replace(/^orm-driver-/, '');
}

/** The statement's own first keyword: `executeSql` runs an INSERT as a select. A `WITH` statement is named by its builder. */
export function operationName(sql: string, context: QueryContext): string {
  const keyword = LEADING_KEYWORD.exec(sql)?.[1]?.toUpperCase();
  return keyword !== undefined && keyword !== 'WITH' ? keyword : (OPERATION_OF_CONTEXT.get(context) ?? keyword ?? 'QUERY');
}

export function startStatementSpan(sql: string, target: StatementTarget): Span {
  const span = tracer().startSpan('db.query', {
    kind: SpanKind.CLIENT,
    attributes: { 'db.system.name': dbSystemName(target.driver), [SpinaAttr.QueryConnection]: target.connection },
  });

  // Sanitizing and hashing cost more than the span; id-only mode skips them.
  if (span.isRecording()) {
    const text = sanitizeSql(sql, target.ansiQuotedIdentifiers);
    span.setAttributes({
      'db.operation.name': operationName(sql, target.context),
      'db.query.text': text.length > MAX_QUERY_TEXT ? text.slice(0, MAX_QUERY_TEXT) : text,
      [SpinaAttr.QueryFingerprint]: fingerprint(sql, target.ansiQuotedIdentifiers),
    });

    if (target.table !== undefined) {
      span.setAttribute('db.collection.name', target.table);
    }
  }

  return span;
}

// db.response.returned_rows is still incubating in semconv 1.43; every other name here is stable.
export function endStatementSpan(span: Span, result: unknown): void {
  if (Array.isArray(result)) {
    span.setAttribute('db.response.returned_rows', result.length);
  }

  span.end();
}

export function failStatementSpan(span: Span, err: unknown): void {
  markSpanErrorType(span, err);
  span.end();
}

/** A cursor that fails to close fails the stream's span too. */
export async function closeStreamCursor(rows: AsyncIterator<unknown>, span: Span): Promise<void> {
  try {
    await rows.return?.();
  } catch (err) {
    markSpanErrorType(span, err);
    throw err;
  }
}

export function spanIds(span: Span): { traceId?: string; spanId?: string } {
  const ctx = span.spanContext();
  return isSpanContextValid(ctx) ? { traceId: ctx.traceId, spanId: ctx.spanId } : {};
}
