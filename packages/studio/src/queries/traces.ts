import { BadRequest } from '@spinajs/exceptions';
import { Param, Query } from '@spinajs/http';
import { StrToLogLevel } from '@spinajs/log';

import type { TraceQuery } from '../contracts/index.js';
import { TEXT, given } from './params.js';

export const MAX_TRACE_LIMIT = 500;
export const MAX_LOG_LIMIT = 1000;

const DATE = { type: 'string', maxLength: 40 } as const;
const DAY_MS = 86_400_000;

const TRACE_QUERY_PROPERTIES = Object.freeze({
  route: TEXT,
  name: TEXT,
  status: { enum: ['', 'error', 'ok'] },
  minDurationMs: { type: 'number', minimum: 0, maximum: DAY_MS },
  principalId: TEXT,
  from: DATE,
  to: DATE,
  limit: { type: 'integer', minimum: 1, maximum: MAX_TRACE_LIMIT },
  cursor: { type: 'string', pattern: '^(\\d{1,20}:[0-9a-f]{32})?$' },
});

/** One `GET /api/traces` query value, validated as its own `@Query()` argument; the handler parameter carries its name. */
export function TraceQueryArg(name: keyof TraceQuery): ReturnType<typeof Query> {
  return Query(TRACE_QUERY_PROPERTIES[name]);
}

export function TraceIdParam(): ReturnType<typeof Param> {
  return Param({ type: 'string', pattern: '^[0-9a-f]{32}$' }, { required: true });
}

const LOG_QUERY_PROPERTIES = Object.freeze({
  traceId: { type: 'string', pattern: '^([0-9a-f]{32})?$' },
  level: { enum: ['', ...Object.keys(StrToLogLevel)] },
  limit: { type: 'integer', minimum: 1, maximum: MAX_LOG_LIMIT },
});

export function LogQueryArg(name: keyof typeof LOG_QUERY_PROPERTIES): ReturnType<typeof Query> {
  return Query(LOG_QUERY_PROPERTIES[name]);
}

export interface TraceQueryArgs {
  route: string | undefined;
  name: string | undefined;
  status: string | undefined;
  minDurationMs: number | undefined;
  principalId: string | undefined;
  from: string | undefined;
  to: string | undefined;
  limit: number | undefined;
  cursor: string | undefined;
}

// A schema cannot say "a date Date.parse understands".
function dateOf(value: string | undefined, name: string): string | undefined {
  const date = given(value);
  if (date !== undefined && Number.isNaN(Date.parse(date))) throw new BadRequest(`${name} must be an ISO date`);
  return date;
}

/** The validated arguments as the store's query: empty values dropped, dates checked. */
export function traceQuery(args: TraceQueryArgs): TraceQuery {
  const route = given(args.route);
  const name = given(args.name);
  const principalId = given(args.principalId);
  const from = dateOf(args.from, 'from');
  const to = dateOf(args.to, 'to');
  const cursor = given(args.cursor);
  return {
    ...(route ? { route } : {}),
    ...(name ? { name } : {}),
    ...(args.status === 'error' || args.status === 'ok' ? { status: args.status } : {}),
    ...(args.minDurationMs === undefined ? {} : { minDurationMs: args.minDurationMs }),
    ...(principalId ? { principalId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(cursor ? { cursor } : {}),
  };
}
