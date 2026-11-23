import { Param, Query } from '@spinajs/http';

/** Longest free-text query or path value Studio accepts. */
export const MAX_TEXT = 512;

export const TEXT = { type: 'string', maxLength: MAX_TEXT } as const;
// Empty is allowed: `?domain=` means "no domain given".
const DOMAIN = { type: 'string', pattern: '^[A-Za-z0-9_.-]{0,64}$' } as const;
const OFFSET = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

/** A query value that was sent and is not empty. */
export function given(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function TextQuery(options?: { required?: boolean }): ReturnType<typeof Query> {
  return Query(TEXT, options);
}

export function TextParam(): ReturnType<typeof Param> {
  return Param({ type: 'string', minLength: 1, maxLength: MAX_TEXT }, { required: true });
}

/** `?domain=`: an authz domain name; the handler parameter is named `domain`. */
export function DomainQuery(): ReturnType<typeof Query> {
  return Query(DOMAIN);
}

/** `?limit=` from 1 to `max`; the handler parameter is named `limit`. */
export function LimitQuery(max: number): ReturnType<typeof Query> {
  return Query({ type: 'integer', minimum: 1, maximum: max });
}

/** `?cursor=` of an offset-paged list; the handler parameter is named `cursor`. */
export function OffsetCursorQuery(): ReturnType<typeof Query> {
  return Query(OFFSET);
}
