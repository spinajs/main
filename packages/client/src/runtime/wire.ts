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
  path: Record<string, string>;
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

/** The `[key, value]` pairs a `whole` argument contributes, or the one pair under `wire.name`. */
function pairs(wire: ArgWire, value: unknown): [string, unknown][] {
  if (wire.shape === 'whole') return Object.entries((value ?? {}) as Bag).filter(([, v]) => v !== undefined && v !== null);
  return [[wire.name ?? '', value]];
}

const BINDERS: Record<ArgLocation, (parts: RequestParts, wire: ArgWire, value: unknown) => void> = {
  path: (parts, wire, value) => pairs(wire, value).forEach(([k, v]) => (parts.path[k] = wireText(v, wire.shape))),
  query: (parts, wire, value) => pairs(wire, value).forEach(([k, v]) => appendQuery(parts.query, k, wire.shape === 'json' ? JSON.stringify(v) : v)),
  header: (parts, wire, value) => pairs(wire, value).forEach(([k, v]) => (parts.headers[k.toLowerCase()] = wireText(v, wire.shape))),
  cookie: (parts, wire, value) => pairs(wire, value).forEach(([k, v]) => parts.cookies.push(`${k}=${encodeURIComponent(wireText(v, wire.shape))}`)),
  body: (parts, wire, value) => {
    if (wire.shape === 'whole') parts.body = value;
    else parts.fields[wire.name ?? ''] = value;
  },
  multipart: (parts, wire, value) => {
    const form = (parts.form ??= new FormData());
    pairs(wire, value).forEach(([k, v]) => appendPart(form, k, v, wire.shape));
  },
};

/** Places argument `i` on the request as `wires[i]` says; an omitted (undefined or null) argument sends nothing. */
export function bindArgs(wires: ArgWire[], args: unknown[]): RequestParts {
  const parts = emptyParts();
  wires.forEach((wire, i) => {
    const value = args[i];
    if (value !== undefined && value !== null) BINDERS[wire.in](parts, wire, value);
  });
  return parts;
}
