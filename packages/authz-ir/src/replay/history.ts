import type { ChangeKind, ChangeRecord } from '@spinajs/authz';

export type KeyState =
  | { readonly known: true; readonly value: unknown; readonly origin: 'current' | 'history'; readonly seq?: number }
  | { readonly known: false; readonly reason: string };

/** Changes inside `[T - beforeMs, T + afterMs]` may be on either side of the decision (section 3.2 of the L3 plan). */
export interface ReplayWindow {
  readonly beforeMs: number;
  readonly afterMs: number;
}

export interface KeyInput {
  kind: ChangeKind;
  /** The store's row projected to the payload shape, or undefined when the key is absent now. */
  current: unknown;
  /** The key's changes with `at` after T, in `seq` order. */
  after: readonly ChangeRecord[];
  /** The key's last change with `at` at or before T, if retained. */
  before?: ChangeRecord;
  /** `coveredSince` of the kind (and type), read after the key's history. */
  since?: Date;
  window: ReplayWindow;
  /** Stored precision of instants inside payloads (`changeLogPrecisionMs`); default 1. */
  precisionMs?: number;
}

const UNKNOWN = Symbol('unknown');

const gap = (reason: string): KeyState => ({ known: false, reason });
const afterImage = (c: ChangeRecord): unknown => (c.op === 'remove' ? undefined : c.payload);

/** Why the log of `kind` cannot vouch for `t`, or undefined when it covers it: every `since` is another node's clock. */
export function coverageGap(t: Date, kind: ChangeKind, since: Date | undefined, window: ReplayWindow): string | undefined {
  if (since !== undefined && since.getTime() <= t.getTime() - window.beforeMs) return undefined;
  return `the ${kind} history starts ${since ? `at ${since.toISOString()}` : 'nowhere (not covered)'}`;
}

/** The state of one key at `t`: current state with the changes after `t` undone, or a gap naming why it cannot be told. */
export function stateAt(t: Date, k: KeyInput): KeyState {
  const lower = t.getTime() - k.window.beforeMs;
  const upper = t.getTime() + k.window.afterMs;
  const uncovered = coverageGap(t, k.kind, k.since, k.window);
  if (uncovered !== undefined) return gap(uncovered);
  const known = k.before ? [k.before, ...k.after] : [...k.after];
  const near = known.find((c) => c.at.getTime() >= lower && c.at.getTime() <= upper);
  if (near) return gap(`change seq ${near.seq} at ${near.at.toISOString()} is within the ambiguity window of the decision`);
  const precision = k.precisionMs ?? 1;
  for (let i = 1; i < known.length; i++) {
    const prev = known[i - 1];
    const next = known[i];
    if (next.before !== null && !sameImage(afterImage(prev), next.before, precision)) return gap(`a write outside the changelog between seq ${prev.seq} and seq ${next.seq}`);
  }
  const last = known.at(-1);
  if (last && !sameImage(afterImage(last), k.current, precision)) return gap(`the current ${k.kind} differs from its last logged change (seq ${last.seq}): a write outside the changelog`);
  const first = k.after[0];
  if (first === undefined) return { known: true, value: k.current, origin: 'current' };
  const value = beforeImage(first, k.before);
  if (value === UNKNOWN) return gap(`seq ${first.seq} is a put without a before-image and no earlier change is retained`);
  return { known: true, value, origin: 'history', seq: first.seq };
}

// add: absent before; a before-image when logged; remove: what was removed; put: else the last earlier after-image.
function beforeImage(c: ChangeRecord, earlier: ChangeRecord | undefined): unknown {
  if (c.op === 'add') return undefined;
  if (c.before !== null) return c.before;
  if (c.op === 'remove' && c.payload !== null) return c.payload;
  return earlier ? afterImage(earlier) : UNKNOWN;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Equality of two JSON images. Instants (Dates, ISO strings) are equal when they differ by less than `precisionMs`:
 * MySQL keeps whole seconds in a datetime column while a logged payload keeps the milliseconds it was given.
 */
export function sameImage(a: unknown, b: unknown, precisionMs = 1): boolean {
  return equalJson(toJson(a), toJson(b), precisionMs);
}

function toJson(v: unknown): unknown {
  const text = JSON.stringify(v);
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

function equalJson(a: unknown, b: unknown, precisionMs: number): boolean {
  if (typeof a === 'string' && typeof b === 'string' && a !== b && ISO_INSTANT.test(a) && ISO_INSTANT.test(b)) return Math.abs(Date.parse(a) - Date.parse(b)) < precisionMs;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equalJson(x, b[i], precisionMs));
  return equalRecords(a as Record<string, unknown>, b as Record<string, unknown>, precisionMs);
}

function equalRecords(a: Record<string, unknown>, b: Record<string, unknown>, precisionMs: number): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equalJson(a[key], b[key], precisionMs));
}
