import { createHmac, randomBytes } from 'node:crypto';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import type { AuditEvent, AuditWriteOptions, TrailConfig } from './contracts.js';
import { AuditConfigError } from './errors.js';
import { isRecord, quoted } from './guards.js';
import { canonicalJson } from './hash.js';

export const MASKED = '***';

const OMIT = Symbol('omit');
const TOP_LEVEL = ['actor', 'onBehalfOf', 'origin', 'dataSubject'] as const;
const UNSAFE = ['', '__proto__', 'constructor', 'prototype'];

type Leaf = (value: unknown) => unknown;
type Lists = Pick<TrailConfig, 'omit' | 'mask' | 'hash'>;
type TopLevel = (typeof TOP_LEVEL)[number];
type MutableEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

const isTopLevel = (path: string): path is TopLevel => (TOP_LEVEL as readonly string[]).includes(path);

let processKey: Buffer | undefined;

/** Keyed hash of a value: equal values stay correlatable without being readable. Without `audit.hashKey.secret` the key is random per process. */
export function auditHash(value: string, container: IContainer = DI.RootContainer): string {
  const secret = container.get(Configuration)?.get<unknown>(['audit', 'hashKey', 'secret']);
  const key = typeof secret === 'string' && secret !== '' ? Buffer.from(secret, 'utf8') : (processKey ??= randomBytes(32));
  return createHmac('sha256', key).update(value).digest('base64url');
}

// A number or bigint hashes as its decimal text and a value written as a JSON string (a Date, a URL) as that text, like
// the same identifier stored as a string, so the two stay correlatable.
function hashText(path: string, v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  let text: string;
  try {
    text = canonicalJson(v);
  } catch (err) {
    throw new AuditConfigError(`audit: hash path ${quoted(path)} reached a value that cannot be written as JSON`, undefined, undefined, err);
  }
  const parsed: unknown = text.startsWith('"') ? JSON.parse(text) : undefined;
  return typeof parsed === 'string' ? parsed : text;
}

const hashed =
  (container: IContainer) =>
  (path: string): Leaf =>
  (v) =>
    v === undefined || v === null ? v : auditHash(hashText(path, v), container);

const united = (trail: readonly string[], call: readonly string[]): readonly string[] => [...new Set([...trail, ...call])];

// A path never enters these; any other object, a class instance included, is entered so masking cannot fail open.
const isLeafObject = (v: object): boolean => v instanceof Date || v instanceof ArrayBuffer || ArrayBuffer.isView(v);

// Copies along the path only, as plain objects.
function rewrite(node: unknown, path: readonly string[], leaf: Leaf): unknown {
  const [head, ...rest] = path;
  const visit = (value: unknown): unknown => (rest.length === 0 ? leaf(value) : rewrite(value, rest, leaf));
  if (Array.isArray(node)) return node.map((value: unknown, i) => (head === '*' || head === String(i) ? visit(value) : value)).filter((value) => value !== OMIT);
  if (node === null || typeof node !== 'object' || isLeafObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const next = head === '*' || head === key ? visit(value) : value;
    if (next !== OMIT && key !== '__proto__') out[key] = next;
  }
  return out;
}

// Only a field the event has is rewritten, so masking never adds one.
function rewriteField(event: MutableEvent, field: TopLevel, leaf: Leaf): void {
  if (event[field] === undefined) return;
  const next = leaf(event[field]);
  if (next === OMIT) {
    if (field !== 'actor') delete event[field];
  } else if (typeof next === 'string') {
    event[field] = next;
  }
}

function apply(event: MutableEvent, path: string, leaf: Leaf): void {
  if (isTopLevel(path)) {
    rewriteField(event, path, leaf);
    return;
  }
  const data = rewrite(event.data, path.split('.').slice(1), leaf);
  if (isRecord(data)) event.data = data;
}

/** Throws for a path that could remove or retype a field every store relies on. */
export function assertMaskPaths(where: string, lists: Lists): void {
  for (const [name, paths] of Object.entries(lists)) {
    for (const path of paths) {
      const segments = path.split('.');
      const inData = segments[0] === 'data' && segments.length > 1;
      const topLevel = segments.length === 1 && isTopLevel(path) && !(name === 'omit' && path === 'actor');
      if ((!inData && !topLevel) || segments.some((s) => UNSAFE.includes(s))) {
        throw new AuditConfigError(`audit: ${where}: ${name} path ${quoted(path)} is not maskable; use data.<path>, or actor, onBehalfOf, origin or dataSubject (actor cannot be omitted)`);
      }
    }
  }
}

/** The trail's lists united with the call's, each path once: omit first, then mask, then hash. */
export function maskOf(trail: TrailConfig, options: AuditWriteOptions, container: IContainer = DI.RootContainer): (event: AuditEvent) => AuditEvent {
  const own: Lists = { omit: options.omit ?? [], mask: options.mask ?? [], hash: options.hash ?? [] };
  assertMaskPaths(`a write to trail ${quoted(trail.name)}`, own);
  const steps: readonly (readonly [readonly string[], (path: string) => Leaf])[] = [
    [united(trail.omit, own.omit), () => () => OMIT],
    [united(trail.mask, own.mask), () => () => MASKED],
    [united(trail.hash, own.hash), hashed(container)],
  ];
  return (event) => {
    const out: MutableEvent = { ...event };
    for (const [paths, leafAt] of steps) {
      for (const path of paths) apply(out, path, leafAt(path));
    }
    return out;
  };
}
