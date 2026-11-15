import { DateTime } from 'luxon';

import type { CaseOrder } from './case.js';

export interface NormalizeOptions {
  order: CaseOrder;
  booleans?: readonly string[];
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

function byText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function normalizeObject(value: object, booleans: ReadonlySet<string>): Record<string, unknown> {
  const entries = Object.entries(value).sort(([a], [b]) => byText(a, b));
  return Object.fromEntries(entries.map(([key, inner]) => [key, normalizeValue(inner, booleans, key)]));
}

function normalizeScalar(value: unknown, booleans: ReadonlySet<string>, key: string | undefined): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number' && key !== undefined && booleans.has(key) && (value === 0 || value === 1)) {
    return value === 1;
  }

  // Drivers disagree on whether numeric, decimal, bigint and count(*) come back as numbers or strings.
  if (typeof value === 'string' && NUMERIC.test(value)) {
    return Number(value);
  }

  return value;
}

function normalizeValue(value: unknown, booleans: ReadonlySet<string>, key?: string): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (DateTime.isDateTime(value)) {
    return value.toUTC().toISO();
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => normalizeValue(item, booleans));
  }

  if (typeof value === 'object') {
    return normalizeObject(value, booleans);
  }

  return normalizeScalar(value, booleans, key);
}

const canonical = (a: unknown, b: unknown): number => byText(JSON.stringify(a), JSON.stringify(b));

export function normalizeResult(value: unknown, options: NormalizeOptions): unknown {
  const normalized = normalizeValue(value, new Set(options.booleans ?? []));
  return options.order === 'unordered' && Array.isArray(normalized) ? [...normalized].sort(canonical) : normalized;
}
