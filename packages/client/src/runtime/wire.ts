import type { PathArgument } from './path.js';
import { appendQuery } from './query.js';

export type ArgLocation = 'query' | 'path' | 'body' | 'header' | 'cookie' | 'multipart';
export type ArgShape = 'value' | 'json' | 'whole' | 'field';

/** How one positional argument travels: a structural copy of the manifest's `ParamWire` (arguments the server injects are never passed). */
export interface ArgWire {
  in: ArgLocation;
  /** Key on the wire; absent for `whole`, where the argument's own keys are used. */
  name?: string;
  shape: ArgShape;
  /** The argument is an array sent as repeated parts under `name`. */
  multiple?: true;
}

type Bag = Record<string, unknown>;

export interface RequestParts {
  path: Record<string, PathArgument>;
  query: string[];
  headers: Record<string, string>;
  cookies: string[];
  body?: unknown;
  fields: Bag;
  form?: FormData;
}

export function emptyParts(): RequestParts {
  return { path: {}, query: [], headers: {}, cookies: [], fields: {} };
}

export function wireText(value: unknown, shape: ArgShape): string {
  if (shape === 'json') return JSON.stringify(value);
  return value instanceof Date ? value.toISOString() : String(value);
}

export function pathArgument(value: unknown, shape: ArgShape): PathArgument {
  return { value, text: wireText(value, shape) };
}

// RFC 9110 token for names; values are what fetch's Headers accepts: tab, visible ASCII, space and Latin-1 obs-text.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

export function checkHeader(name: string, value: string): void {
  if (!TOKEN.test(name)) throw new TypeError(`Header name '${name}' is not a valid HTTP token`);
  if (!HEADER_VALUE.test(value)) throw new TypeError(`Header '${name}' holds a control or non-Latin-1 character; encode the value before sending it`);
}

function cookiePair(name: string, value: string): string {
  if (!TOKEN.test(name)) throw new TypeError(`Cookie name '${name}' is not a valid HTTP token`);
  return `${name}=${encodeURIComponent(value)}`;
}

function partValue(value: unknown, shape: ArgShape): string | Blob {
  if (value instanceof Blob) return value;
  return typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : wireText(value, shape);
}

export function appendPart(form: FormData, name: string, value: unknown, shape: ArgShape = 'value'): void {
  if (value === undefined || value === null) return;
  for (const item of Array.isArray(value) && shape !== 'json' ? (value as unknown[]) : [value]) {
    if (item !== undefined && item !== null) form.append(name, partValue(item, shape));
  }
}

const isNested = (value: unknown): value is object => typeof value === 'object' && value !== null && !(value instanceof Date) && !(value instanceof Blob);

/** `@Form()` reads its fields back with `qs`, so nested values travel as `a[b]` and `a[0]` keys. */
function appendFormField(form: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isNested(value)) {
    form.append(key, partValue(value, 'value'));
    return;
  }
  const entries = Array.isArray(value) ? (value as unknown[]).map((item, i) => [String(i), item] as const) : Object.entries(value);
  for (const [child, item] of entries) appendFormField(form, `${key}[${child}]`, item);
}

/** The `[key, value]` pairs a `whole` argument contributes, or the one pair under `wire.name`. */
function pairs(wire: ArgWire, value: unknown): [string, unknown][] {
  if (wire.shape === 'whole') return Object.entries((value ?? {}) as Bag).filter(([, v]) => v !== undefined && v !== null);
  return [[wire.name ?? '', value]];
}

const BINDERS: Record<ArgLocation, (parts: RequestParts, wire: ArgWire, value: unknown) => void> = {
  path: (parts, wire, value) => pairs(wire, value).forEach(([k, v]) => (parts.path[k] = pathArgument(v, wire.shape))),
  query: (parts, wire, value) => pairs(wire, value).forEach(([k, v]) => appendQuery(parts.query, k, wire.shape === 'json' ? JSON.stringify(v) : v)),
  header: (parts, wire, value) =>
    pairs(wire, value).forEach(([k, v]) => {
      const text = wireText(v, wire.shape);
      checkHeader(k, text);
      parts.headers[k.toLowerCase()] = text;
    }),
  cookie: (parts, wire, value) => pairs(wire, value).forEach(([k, v]) => parts.cookies.push(cookiePair(k, wireText(v, wire.shape)))),
  body: (parts, wire, value) => {
    if (wire.shape === 'whole') parts.body = value;
    else parts.fields[wire.name ?? ''] = value;
  },
  multipart: (parts, wire, value) => {
    const form = (parts.form ??= new FormData());
    if (wire.shape === 'whole') pairs(wire, value).forEach(([k, v]) => appendFormField(form, k, v));
    else pairs(wire, value).forEach(([k, v]) => appendPart(form, k, v, wire.shape));
  },
};

/** Places argument `i` on the request as `wires[i]` says; an omitted (undefined or null) argument sends nothing. */
export function bindArgs(wires: ArgWire[], args: unknown[]): RequestParts {
  const parts = emptyParts();
  wires.forEach((wire, i) => {
    const value = args[i];
    if (value !== undefined && value !== null) BINDERS[wire.in](parts, wire, value);
  });
  // The server parses no JSON body out of a multipart request: a body argument would reach the handler as null.
  if (parts.form && (parts.body !== undefined || Object.keys(parts.fields).length > 0)) {
    throw new TypeError('A body argument cannot travel with multipart arguments: the server reads no body from a multipart request');
  }
  return parts;
}
