import type { ReplayChange, RowImage } from './change.js';

export type KeyState<I = RowImage> =
  | { readonly known: true; readonly value: I | undefined; readonly origin: 'current' | 'history'; readonly seq?: number }
  | { readonly known: false; readonly reason: string };

/** Changes inside `[T - beforeMs, T + afterMs]` may be on either side of the recording. */
export interface ReplayWindow {
  readonly beforeMs: number;
  readonly afterMs: number;
}

export interface KeyInput<I = RowImage> {
  /** Names the entity in a gap's reason. */
  entity: string;
  /** The key's row now, in the shape of the changes' images, or undefined when the key is absent now. */
  current: I | undefined;
  /** The key's changes with `at` after T, in `seq` order. */
  after: readonly ReplayChange<I>[];
  /** The key's last change with `at` at or before T, if retained. */
  before?: ReplayChange<I>;
  /** From when the stream holds every write of the entity, read after the key's history. */
  since?: Date;
  window: ReplayWindow;
  /**
   * Precision of the instants inside images, that of the coarsest column they come from; default 1 ms. A column
   * coarser than stated here turns healthy keys into gaps.
   */
  precisionMs?: number;
}

const UNKNOWN = Symbol('unknown');

const gap = (reason: string): Extract<KeyState, { known: false }> => ({ known: false, reason });
const afterImage = <I>(c: ReplayChange<I>): I | null | undefined => (c.op === 'remove' ? undefined : c.image);

/** Why the history of `entity` cannot vouch for `t`, or undefined when it covers it: every `since` is another node's clock. */
export function coverageGap(t: Date, entity: string, since: Date | undefined, window: ReplayWindow): string | undefined {
  if (since !== undefined && since.getTime() <= t.getTime() - window.beforeMs) return undefined;
  return `the ${entity} history starts ${since ? `at ${since.toISOString()}` : 'nowhere (not covered)'}`;
}

/** The state of one key at `t`: current state with the changes after `t` undone, or a gap naming why it cannot be told. */
export function stateAt<I = RowImage>(t: Date, k: KeyInput<I>): KeyState<I> {
  const lower = t.getTime() - k.window.beforeMs;
  const upper = t.getTime() + k.window.afterMs;
  const uncovered = coverageGap(t, k.entity, k.since, k.window);
  if (uncovered !== undefined) return gap(uncovered);
  const known = k.before ? [k.before, ...k.after] : [...k.after];
  const near = known.find((c) => c.at.getTime() >= lower && c.at.getTime() <= upper);
  if (near) return gap(`change seq ${near.seq} at ${near.at.toISOString()} is within the ambiguity window of the decision`);
  const precision = k.precisionMs ?? 1;
  for (let i = 1; i < known.length; i++) {
    const prev = known[i - 1];
    const next = known[i];
    if (!follows(afterImage(prev), next, precision)) return gap(`a write outside the changelog between seq ${prev.seq} and seq ${next.seq}`);
  }
  const last = known.at(-1);
  if (last && !sameImage(afterImage(last), k.current, precision)) return gap(`the current ${k.entity} differs from its last logged change (seq ${last.seq}): a write outside the changelog`);
  const first = k.after[0];
  if (first === undefined) return { known: true, value: k.current, origin: 'current' };
  const value = beforeImage(first, k.before);
  if (value === UNKNOWN) return gap(`seq ${first.seq} is a put without a before-image and no earlier change is retained`);
  return { known: true, value, origin: 'history', seq: first.seq };
}

/** Can `next` be the change that came right after a key held `state`? A stream records no write that changes nothing. */
function follows(state: unknown, next: ReplayChange<unknown>, precisionMs: number): boolean {
  if (next.op === 'add') return state === undefined;
  if (state === undefined) return false;
  if (next.before !== null) return sameImage(state, next.before, precisionMs);
  return next.op !== 'remove' || next.image === null || sameImage(state, next.image, precisionMs);
}

// add: absent before; a before-image when recorded; remove: what was removed; put: else the last earlier after-image.
// An earlier change without an image cannot vouch for a state.
function beforeImage<I>(c: ReplayChange<I>, earlier: ReplayChange<I> | undefined): I | undefined | typeof UNKNOWN {
  if (c.op === 'add') return undefined;
  if (c.before !== null) return c.before;
  if (c.op === 'remove' && c.image !== null) return c.image;
  const image = earlier === undefined ? null : afterImage(earlier);
  return image === null ? UNKNOWN : image;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// A string, or a number outside strings in group 1.
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/**
 * Equality of two JSON images. Instants (Dates, ISO strings) are equal when they differ by less than `precisionMs`, the
 * precision of the column an image's instants come from. Two texts of a JSON object or array are equal by value.
 * Values JSON cannot hold (Map, Set, bigint, non-finite numbers, invalid dates) and values nested deeper than 256
 * levels are never the same: a gap rather than a guess.
 *
 * The text rule is wider than orm-history's, which compares by value only in a column it knows as JSON: here a plain
 * text column holding object or array text, and a string nested in a JSON value, compare by value too. Only a write
 * made outside the history can differ from its last change in that way alone, and such a write is then not seen.
 */
export function sameImage(a: unknown, b: unknown, precisionMs = 1): boolean {
  return plainJson(a, 0) && plainJson(b, 0) && equalJson(toJson(a), toJson(b), precisionMs, 0);
}

// The comparison recurses: a value nested about 10,000 levels deep, which one stored text can hold, overflows the stack.
const MAX_DEPTH = 256;

function plainJson(v: unknown, depth: number): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol') return false;
  if (v === null || typeof v !== 'object') return true;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  return depth < MAX_DEPTH && !(v instanceof Map || v instanceof Set) && Object.values(v).every((x) => plainJson(x, depth + 1));
}

function toJson(v: unknown): unknown {
  const text = JSON.stringify(v);
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

function equalJson(a: unknown, b: unknown, precisionMs: number, depth: number): boolean {
  if (typeof a === 'string' && typeof b === 'string' && a !== b) return equalText(a, b, precisionMs, depth);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equalJson(x, b[i], precisionMs, depth + 1));
  return equalRecords(a as Record<string, unknown>, b as Record<string, unknown>, precisionMs, depth);
}

function equalRecords(a: Record<string, unknown>, b: Record<string, unknown>, precisionMs: number, depth: number): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equalJson(a[key], b[key], precisionMs, depth + 1));
}

// A JSON column kept as text holds one value under many texts, and history records no change between two of them, so
// object and array texts compare by value. A scalar text never does: a plain text column keeps the exact comparison.
function equalText(a: string, b: string, precisionMs: number, depth: number): boolean {
  if (ISO_INSTANT.test(a) && ISO_INSTANT.test(b)) return Math.abs(Date.parse(a) - Date.parse(b)) < precisionMs;
  const x = jsonText(a);
  const y = jsonText(b);
  return x !== undefined && y !== undefined && equalJson(x, y, precisionMs, depth);
}

function jsonText(text: string): object | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    // After the parse, as orm-history scans: on text with unclosed quotes the scan is quadratic.
    return typeof value === 'object' && value !== null && !holdsLossyNumber(text) ? value : undefined;
  } catch {
    return undefined;
  }
}

// orm-history's rule (`sameJsonText`): parsing merges numbers a double cannot tell apart (beyond 2^53, 1e400 and null),
// so such text stays compared as text. A false positive only keeps the text comparison.
function holdsLossyNumber(text: string): boolean {
  for (const [, token] of text.matchAll(JSON_TOKEN)) {
    if (token === undefined) continue;
    const n = Number(token);
    const digits = significantDigits(token);
    if (!Number.isFinite(n) || digits > 15 || (digits > 0 && Math.abs(n) < 2 ** -1022)) return true;
  }
  return false;
}

const isNonZeroDigit = (code: number): boolean => code >= 49 && code <= 57;

// Index scans, not a regular expression: trimming zeros with `/0+$/` is quadratic on a long run of inner zeros.
function significantDigits(token: string): number {
  let end = token.indexOf('e');
  if (end === -1) end = token.indexOf('E');
  if (end === -1) end = token.length;
  let first = 0;
  while (first < end && !isNonZeroDigit(token.charCodeAt(first))) first++;
  if (first === end) return 0;
  let last = end - 1;
  while (!isNonZeroDigit(token.charCodeAt(last))) last--;
  const dot = token.indexOf('.');
  return last - first + 1 - (dot > first && dot < last ? 1 : 0);
}
