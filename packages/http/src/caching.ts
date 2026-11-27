import type express from 'express';
import type { IResponseHeader, Response } from './interfaces.js';

export type VaryValue = IResponseHeader['Value'] | undefined;

function fieldsOf(value: VaryValue): string[] {
  if (value === undefined) return [];
  const text = typeof value === 'object' ? value.join(',') : String(value);
  return text
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
}

/**
 * The `Vary` field names of `values`, in order and once each (compared case-insensitively, the first spelling kept).
 * `*` stands for every field, so it replaces the list.
 */
export function mergeVary(...values: readonly VaryValue[]): string[] {
  const out: string[] = [];
  for (const field of values.flatMap(fieldsOf)) {
    if (field === '*') return ['*'];
    if (!out.some((f) => f.toLowerCase() === field.toLowerCase())) out.push(field);
  }
  return out;
}

/**
 * Adds `fields` to the `Vary` of a reply about to be sent, for an `onAfter` hook. Keeps the value on `res` (CORS adds
 * `Origin` before the route runs) and the answer's own `Vary`, which `execute()` would write over `res`'s; the merged
 * value goes to both, so a later `res.vary()` appends to it.
 */
export function appendVary(res: express.Response, response: Response, fields: readonly string[]): void {
  if (fields.length === 0) return;
  const own = response.headers.find((h) => h.Name.toLowerCase() === 'vary');
  const value = mergeVary(res.getHeader('Vary'), own?.Value, fields).join(', ');
  res.setHeader('Vary', value);
  if (own) response.setHeader('Vary', value);
}

/**
 * Whether an `If-None-Match` value names `etag` by the weak comparison of RFC 9110 §13.1.2 (`W/"a"` matches `"a"`);
 * `*` matches any. A header sent twice is one list.
 */
export function etagMatches(ifNoneMatch: string | readonly string[] | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const opaque = (tag: string): string => (tag.startsWith('W/') ? tag.slice(2) : tag);
  const wanted = opaque(etag.trim());
  return fieldsOf(ifNoneMatch).some((tag) => tag === '*' || opaque(tag) === wanted);
}
