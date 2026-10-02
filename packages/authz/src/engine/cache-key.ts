import { ceilingHash, principalKey } from '../contracts/principal.js';
import type { Ceiling, Principal, ResourceRef } from '../contracts/principal.js';
import { isPermission } from '../contracts/permission.js';
import type { Permission } from '../contracts/permission.js';
import { resourceKey } from '../contracts/resource.js';
import type { AuthorizationModel } from '../contracts/model.js';

// A collision in these keys would serve one principal another's cached
// decision. Every function here answers undefined (do not cache) rather than
// guess, and reads each input property once, through its descriptor, so a
// getter cannot show the key one value and the models another.

const MAX_DELEGATION_DEPTH = 8;
const MAX_VALUE_DEPTH = 16;
// Shared subtrees are walked once per path, so the walk is bounded by visits, not by distinct objects.
const MAX_VALUES = 10_000;
const MAX_KEY_LENGTH = 64 * 1024;
const SEP = '\u0000';

class NotCanonical extends Error {}

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

interface Budget {
  left: number;
}

const budget = (): Budget => ({ left: MAX_VALUES });

const fail = (): never => {
  throw new NotCanonical();
};

const charge = (b: Budget, n: number): void => {
  b.left -= n;
  if (b.left < 0) fail();
};

const canonical = <T>(f: () => T): T | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

const isObject = (v: unknown): v is object => v !== null && typeof v === 'object';

const isPlain = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// No prototype: an own '__proto__' key (JSON.parse keeps one) stays a key instead of hitting the setter.
const record = (): Record<string, Json> => Object.create(null) as Record<string, Json>;

// Surrogates (D800-DFFF) move above E000-FFFF, so UTF-16 units compare in code point order.
const fixup = (c: number): number => (c >= 0xe000 ? c - 0x800 : c >= 0xd800 ? c + 0x2000 : c);
const compareCodePoints = (x: string, y: string): number => {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const cx = x.charCodeAt(i);
    const cy = y.charCodeAt(i);
    if (cx !== cy) return fixup(cx) - fixup(cy);
  }
  return x.length - y.length;
};

/** Own enumerable data properties, read once; anything else (symbol key, accessor, hidden key) has no canonical form. */
function ownData(o: object, b: Budget, ignore?: string): Map<string, unknown> {
  const keys = Reflect.ownKeys(o);
  charge(b, keys.length);
  const out = new Map<string, unknown>();
  for (const k of keys) {
    if (k === ignore) continue;
    if (typeof k !== 'string') return fail();
    const d = Reflect.getOwnPropertyDescriptor(o, k);
    if (d === undefined || !('value' in d) || !d.enumerable) return fail();
    out.set(k, d.value);
  }
  return out;
}

/** An object whose contract fields must not come from the prototype chain; `plain` also rejects class instances. */
function fieldsOf(o: unknown, known: readonly string[], b: Budget, options: { readonly plain?: boolean; readonly ignore?: string } = {}): Map<string, unknown> {
  if (!isObject(o)) return fail();
  if (options.plain && !isPlain(o)) return fail();
  const fields = ownData(o, b, options.ignore);
  for (const k of known) if (!fields.has(k) && k in o) fail();
  return fields;
}

function arrayOf(v: unknown, b: Budget): unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return fail();
  const length: unknown = Reflect.getOwnPropertyDescriptor(v, 'length')?.value;
  if (typeof length !== 'number') return fail();
  charge(b, length);
  if (Reflect.ownKeys(v).length !== length + 1) return fail();
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const d = Reflect.getOwnPropertyDescriptor(v, String(i));
    if (d === undefined || !('value' in d) || !d.enumerable) return fail();
    out.push(d.value);
  }
  return out;
}

const strings = (v: unknown, b: Budget): string[] => arrayOf(v, b).map((x) => (typeof x === 'string' ? x : fail()));

function dateTime(v: unknown): number | undefined {
  if (!isObject(v) || Object.getPrototypeOf(v) !== Date.prototype) return undefined;
  if (Reflect.ownKeys(v).length !== 0) fail();
  return Date.prototype.getTime.call(v);
}

const iso = (t: number): string => (Number.isNaN(t) ? 'invalid' : new Date(t).toISOString());

// '$' keys of user objects get one more '$', so no user object can spell a tag ('$date', '$undefined').
const escapeKey = (k: string): string => (k.startsWith('$') ? `$${k}` : k);

function value(v: unknown, depth: number, path: Set<object>, b: Budget): Json {
  charge(b, 1);
  if (v === undefined) return { $undefined: true };
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? v : fail();
  if (!isObject(v)) return fail();
  const time = dateTime(v);
  if (time !== undefined) return { $date: iso(time) };
  if (depth > MAX_VALUE_DEPTH || path.has(v)) return fail();
  path.add(v);
  try {
    if (Array.isArray(v)) return arrayOf(v, b).map((x) => value(x, depth + 1, path, b));
    if (!isPlain(v)) return fail();
    const out = record();
    for (const [k, x] of ownData(v, b)) out[escapeKey(k)] = value(x, depth + 1, path, b);
    return out;
  } finally {
    path.delete(v);
  }
}

const rest = (fields: Map<string, unknown>, known: readonly string[], b: Budget): Json => {
  const out = record();
  for (const [k, x] of fields) if (!known.includes(k)) out[escapeKey(k)] = value(x, 1, new Set(), b);
  return out;
};

const orNull = (v: unknown, b: Budget): Json => (v === undefined || v === null ? null : value(v, 1, new Set(), b));

function refKey(v: unknown, b: Budget): string {
  const fields = fieldsOf(v, ['type', 'id'], b);
  const type = fields.get('type');
  const id = fields.get('id');
  if (typeof type !== 'string' || typeof id !== 'string') return fail();
  return principalKey({ type, id });
}

const CEILING_FIELDS = ['roles', 'permissions', 'resources', 'expiresAt', 'reason'];

// ceilingHash reads fields more than once and collapses some malformed
// values, so it runs on a validated snapshot.
function ceilingState(v: unknown, b: Budget): Json {
  if (v === undefined || v === null) return { hash: ceilingHash(undefined), rest: {} };
  const fields = fieldsOf(v, CEILING_FIELDS, b, { plain: true });
  const snapshot: { -readonly [K in keyof Ceiling]: Ceiling[K] } = {};
  const roles = fields.get('roles');
  if (roles != null) snapshot.roles = strings(roles, b);
  const permissions = fields.get('permissions');
  if (permissions != null) snapshot.permissions = strings(permissions, b);
  const resources = fields.get('resources');
  if (resources != null) snapshot.resources = arrayOf(resources, b).map((r) => refOf(r, b) ?? fail());
  const expiresAt = fields.get('expiresAt');
  if (expiresAt != null) {
    const time = dateTime(expiresAt);
    snapshot.expiresAt = time === undefined ? fail() : new Date(time);
  }
  const reason = fields.get('reason');
  if (reason != null) snapshot.reason = typeof reason === 'string' ? reason : fail();
  return { hash: ceilingHash(snapshot), rest: rest(fields, CEILING_FIELDS, b) };
}

export const AUTHN_FIELDS: readonly string[] = ['method', 'strategy', 'assurance', 'mfa', 'authenticatedAt', 'impersonator', 'sessionHandle'];

function authnState(v: unknown, b: Budget): Json {
  if (v === undefined || v === null) return null;
  const fields = fieldsOf(v, AUTHN_FIELDS, b, { plain: true });
  const mfa = fields.get('mfa');
  const at = fields.get('authenticatedAt');
  let authenticatedAt: Json = null;
  if (at != null) {
    const time = dateTime(at);
    authenticatedAt = time === undefined ? fail() : iso(time);
  }
  const impersonator = fields.get('impersonator');
  return {
    method: orNull(fields.get('method'), b),
    strategy: orNull(fields.get('strategy'), b),
    assurance: orNull(fields.get('assurance'), b),
    mfa: mfa == null ? null : strings(mfa, b).sort(compareCodePoints),
    authenticatedAt,
    impersonator: impersonator == null ? null : refKey(impersonator, b),
    sessionHandle: orNull(fields.get('sessionHandle'), b),
    rest: rest(fields, AUTHN_FIELDS, b),
  };
}

export const PRINCIPAL_FIELDS: readonly string[] = ['type', 'id', 'authenticated', 'source', 'onBehalfOf', 'delegation', 'companions', 'ceiling', 'attributes', 'authn'];

// What state() keeps of the fields above in a form a residual ref can read. onBehalfOf
// (nested state), companions (a key set) and identity (left out) are not readable.
const KEYED_SCALARS = new Set(['type', 'id', 'authenticated', 'source', 'delegation']);
const KEYED_AUTHN = new Set(['method', 'strategy', 'assurance', 'mfa', 'authenticatedAt', 'sessionHandle']);
// The key holds these as sorted unique sets (ceilingHash): a whole list means the same in any order, an element path does not.
const CEILING_SETS = new Set(['roles', 'permissions', 'resources']);

/**
 * A residual ref may back a cached decision only when the key holds its path.
 * scope.* refs are safe: the L2 entry is tagged with each scope node loaded.
 */
export function cacheSafeRef(r: string): boolean {
  const [root, head, ...tail] = r.split('.');
  if (root === 'scope') return true;
  if ((root !== 'principal' && root !== 'actor') || head === undefined) return false;
  if (head === 'attributes') return true;
  if (head === 'ceiling') return tail.length <= 1 || !CEILING_SETS.has(tail[0]);
  if (head === 'authn') return tail.length === 1 ? KEYED_AUTHN.has(tail[0]) : tail.length === 2 && tail[0] === 'impersonator' && (tail[1] === 'type' || tail[1] === 'id');
  return tail.length === 0 && KEYED_SCALARS.has(head);
}

function state(p: unknown, depth: number, chain: Set<object>, b: Budget): Json {
  if (!isObject(p) || depth > MAX_DELEGATION_DEPTH || chain.has(p)) return fail();
  // 'identity' is opaque and left out, not even its descriptor is checked: a model must not derive a cacheable vote from it.
  const fields = fieldsOf(p, PRINCIPAL_FIELDS, b, { plain: true, ignore: 'identity' });
  const type = fields.get('type');
  const id = fields.get('id');
  if (typeof type !== 'string' || typeof id !== 'string') return fail();
  // The engine denies these before the cache; keying them would only let a forged copy share SYSTEM's key.
  if (type === 'system' || type === 'unattended') return fail();
  chain.add(p);
  try {
    const onBehalfOf = fields.get('onBehalfOf');
    const companions = fields.get('companions');
    const attributes = fields.get('attributes');
    return {
      type,
      id,
      authenticated: orNull(fields.get('authenticated'), b),
      source: orNull(fields.get('source'), b),
      ceiling: ceilingState(fields.get('ceiling'), b),
      delegation: orNull(fields.get('delegation'), b),
      onBehalfOf: onBehalfOf == null ? null : state(onBehalfOf, depth + 1, chain, b),
      companions: companions == null ? [] : [...new Set(arrayOf(companions, b).map((c) => refKey(c, b)))].sort(compareCodePoints),
      attributes: attributes == null ? {} : value(attributes, 1, new Set(), b),
      authn: authnState(fields.get('authn'), b),
      rest: rest(fields, PRINCIPAL_FIELDS, b),
    };
  } finally {
    chain.delete(p);
  }
}

function serialize(v: Json): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${(v as readonly Json[]).map(serialize).join(',')}]`;
  const o = v as { readonly [k: string]: Json };
  const keys = Object.keys(o).sort(compareCodePoints);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(o[k])}`).join(',')}}`;
}

const capped = (s: string): string => (s.length > MAX_KEY_LENGTH ? fail() : s);

/** Canonical JSON of the decision-relevant state of a principal; undefined when it has no canonical form (then nothing is cached). */
export function principalState(p: Principal): string | undefined {
  return canonical(() => capped(serialize(state(p, 0, new Set(), budget()))));
}

/** JSON array of every model's version() ('' when absent), in model order. */
export function versionVector(models: readonly AuthorizationModel[]): string | undefined {
  return canonical(() => {
    const out: string[] = [];
    for (const m of arrayOf(models, budget())) {
      if (!isObject(m)) fail();
      const version = (m as { version?: unknown }).version;
      if (version === undefined) {
        out.push('');
        continue;
      }
      if (typeof version !== 'function') return fail();
      const v: unknown = (version as (this: unknown) => unknown).call(m);
      out.push(typeof v === 'string' ? v : fail());
    }
    return JSON.stringify(out);
  });
}

/** A ref copied from its own data properties; undefined when malformed. A null id counts as absent. */
function refOf(v: unknown, b: Budget): ResourceRef | undefined {
  return canonical(() => {
    const fields = fieldsOf(v, ['type', 'id'], b);
    for (const k of fields.keys()) if (k !== 'type' && k !== 'id') fail();
    const type = fields.get('type');
    const id = fields.get('id');
    if (typeof type !== 'string') return fail();
    if (id === undefined || id === null) return { type };
    return typeof id === 'string' ? { type, id } : fail();
  });
}

const noSep = (v: unknown): v is string => typeof v === 'string' && !v.includes(SEP);

/**
 * The L2 key. Only the resource key may contain NUL (a raw id); every other
 * part is NUL-free, so the split stays unique.
 */
export function decisionKey(parts: { readonly domain: string; readonly principal: Principal; readonly actor?: Principal; readonly permission: Permission; readonly ref: ResourceRef; readonly versions: string }): string | undefined {
  return canonical(() => {
    if (!isObject(parts)) return fail();
    const { domain, principal, actor, permission, ref, versions } = parts;
    if (!noSep(domain) || !noSep(versions) || !isPermission(permission)) return fail();
    const r = refOf(ref, budget()) ?? fail();
    const p = principalState(principal) ?? fail();
    const a = actor === undefined ? '' : principalState(actor) ?? fail();
    return capped([domain, p, a, permission, resourceKey(r), versions].join(SEP));
  });
}

function principalTags(p: unknown, out: Set<string>, depth: number, chain: Set<object>, b: Budget): void {
  if (!isObject(p) || depth > MAX_DELEGATION_DEPTH || chain.has(p)) return fail();
  chain.add(p);
  const fields = fieldsOf(p, ['type', 'id', 'companions', 'onBehalfOf'], b, { ignore: 'identity' });
  const subject = (type: unknown, id: unknown) => {
    if (typeof type !== 'string' || typeof id !== 'string') return fail();
    out.add(`subject:${principalKey({ type, id })}`);
    if (type === 'link') out.add(`link:${id}`);
  };
  subject(fields.get('type'), fields.get('id'));
  const companions = fields.get('companions');
  if (companions != null) {
    for (const c of arrayOf(companions, b)) {
      const ref = fieldsOf(c, ['type', 'id'], b);
      subject(ref.get('type'), ref.get('id'));
    }
  }
  const onBehalfOf = fields.get('onBehalfOf');
  if (onBehalfOf != null) principalTags(onBehalfOf, out, depth + 1, chain, b);
}

/** Tags of an L2 entry; undefined when one cannot be built (then the entry must not be stored, or an invalidation could miss it). */
export function entryTags(parts: { readonly models: readonly string[]; readonly principals: readonly Principal[]; readonly ref: ResourceRef; readonly ancestors: readonly ResourceRef[] | undefined }): readonly string[] | undefined {
  return canonical(() => {
    if (!isObject(parts)) return fail();
    const { models, principals, ref, ancestors } = parts;
    const b = budget();
    const out = new Set<string>(['*']);
    for (const m of arrayOf(models, b)) out.add(`model:${typeof m === 'string' ? m : fail()}`);
    for (const p of arrayOf(principals, b)) principalTags(p, out, 0, new Set(), b);
    const r = refOf(ref, b) ?? fail();
    if (r.id === undefined) {
      out.add('scope:*');
    } else {
      out.add(`scope:${resourceKey(r)}`);
      for (const a of arrayOf(ancestors, b)) out.add(`scope:${resourceKey(refOf(a, b) ?? fail())}`);
    }
    return Object.freeze([...out].sort(compareCodePoints));
  });
}

/** Maps invalidation tags to L2 tags: votes carry no tags, so anything the L2 does not index drops the whole domain. */
export function invalidationTags(tags: readonly string[]): readonly string[] {
  const out = new Set<string>();
  // Invalidation must never be skipped, so a long list is not budgeted.
  const list = canonical(() => arrayOf(tags, { left: Infinity })) ?? ['*'];
  for (const t of list) {
    if (typeof t !== 'string') out.add('*');
    else if (t === '*' || t.startsWith('subject:') || t.startsWith('link:') || t.startsWith('model:')) out.add(t);
    else if (t.startsWith('scope:')) out.add(t).add('scope:*');
    else out.add('*');
  }
  return Object.freeze([...out].sort(compareCodePoints));
}
