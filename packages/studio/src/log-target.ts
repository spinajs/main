import { DI, Injectable, Singleton } from '@spinajs/di';
import { LogLevel, LogTarget } from '@spinajs/log';
import type { ICommonTargetOptions, ILogEntry } from '@spinajs/log';

import { LogStore } from './buffers/log-store.js';
import { TraceStore } from './buffers/trace-store.js';
import type { StudioLogLine } from './contracts/index.js';
import { truncate } from './span.js';

const RESERVED = new Set(['level', 'logger', 'message', 'error', 'traceId', 'spanId', 'trace_id', 'span_id']);

/** Field data kept per line; the fields after it are dropped. */
export const MAX_LOG_LINE_BYTES = 8192;

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

const idOf = (pattern: RegExp, ...values: unknown[]): string | undefined => values.find((v): v is string => typeof v === 'string' && pattern.test(v));

function scalar(v: unknown): string | number | boolean | undefined {
  if (typeof v === 'string') return truncate(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return undefined;
}

function fieldsOf(entry: ILogEntry, redact: ReadonlySet<string>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(entry.Variables)) {
    if (RESERVED.has(key)) continue;
    const kept = redact.has(key) ? '[redacted]' : scalar(value);
    if (kept === undefined) continue;
    bytes += 2 * (key.length + (typeof kept === 'string' ? kept.length : 4));
    if (bytes > MAX_LOG_LINE_BYTES) break;
    fields[key] = kept;
  }
  const error = entry.Variables.error;
  if (error) fields.error = truncate(`${error.name}: ${error.message}`);
  return fields;
}

export function toLogLine(entry: ILogEntry, traceId: string | undefined, redact: ReadonlySet<string>): StudioLogLine {
  const vars = entry.Variables;
  const spanId = idOf(SPAN_ID, vars.spanId, vars.span_id);
  return {
    time: new Date().toISOString(),
    // The logger writes level names in upper case; StrToLogLevel and the query use lower case.
    level: vars.level.toLowerCase(),
    logger: truncate(vars.logger),
    message: typeof vars.message === 'string' ? truncate(vars.message) : '',
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
    fields: fieldsOf(entry, redact),
  };
}

/**
 * Logger target `type: 'StudioLogTarget'`: keeps the lines that carry a trace id (`traceId`, or the older `trace_id`)
 * and every warning and above, with `studio.redactAttributes` masked in the fields. Opt-in: name it in
 * `logger.targets` and route a rule to it.
 */
@Singleton()
@Injectable('StudioLogTarget')
export class StudioLogTarget extends LogTarget<ICommonTargetOptions> {
  public write(entry: ILogEntry): void {
    if (!this.Options.enabled) return;
    const traceId = idOf(TRACE_ID, entry.Variables.traceId, entry.Variables.trace_id);
    if (traceId === undefined && entry.Level < LogLevel.Warn) return;
    const store = DI.get(LogStore);
    if (!store) return;
    // By span id, as the trace store judges own-ness: the trace id is the caller's to choose.
    const spanId = idOf(SPAN_ID, entry.Variables.spanId, entry.Variables.span_id);
    if (spanId !== undefined && DI.get(TraceStore)?.ownsSpan(spanId) === true) return;
    store.add(toLogLine(entry, traceId, store.redact));
  }
}
