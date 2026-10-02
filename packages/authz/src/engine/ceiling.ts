import { FALSE, TRUE, and } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { DenyReason } from '../contracts/decision.js';
import { compilePermissionGlob, isPermissionGlob } from '../contracts/permission.js';
import type { Permission } from '../contracts/permission.js';
import type { Ceiling, ResourceRef } from '../contracts/principal.js';
import { GLOBAL } from '../contracts/resource.js';

export interface CeilingOutcome {
  readonly denials: readonly DenyReason[];
  /** FALSE whenever `denials` is not empty. */
  readonly restrict: ResourceFilter;
  readonly expiresAt?: Date;
}

export type CeilingRead = { readonly ok: true; readonly ceiling?: Ceiling } | { readonly ok: false };

const PRIORITY = 200;
// Lists come from tokens; a hostile length must not turn into a long loop.
const MAX_LIST = 10_000;

export const NO_CEILING: CeilingOutcome = Object.freeze({ denials: Object.freeze([]), restrict: TRUE });

const MALFORMED: CeilingOutcome = Object.freeze({ denials: Object.freeze([Object.freeze({ code: 'ceiling', priority: PRIORITY })]), restrict: FALSE });

/** Covers nothing: what a delegate's unreadable ceiling becomes, so it still denies wherever it is applied. */
export const DENY_ALL_CEILING: Ceiling = Object.freeze({ permissions: Object.freeze([]) });

class Malformed extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/**
 * Reads every field once into a frozen, validated copy. `null` fields count
 * as absent (the `ceilingHash` rule); a wrong type or a throwing read is
 * `{ ok: false }`.
 */
export function readCeiling(c: unknown): CeilingRead {
  if (c === undefined || c === null) return Object.freeze({ ok: true });
  try {
    if (!isObject(c) || Array.isArray(c)) throw new Malformed();
    const roles = c.roles;
    const permissions = c.permissions;
    const resources = c.resources;
    const expiresAt = c.expiresAt;
    const reason = c.reason;

    const out: { -readonly [K in keyof Ceiling]: Ceiling[K] } = {};
    if (roles !== undefined && roles !== null) out.roles = readStrings(roles);
    if (permissions !== undefined && permissions !== null) out.permissions = readStrings(permissions);
    if (resources !== undefined && resources !== null) out.resources = readList(resources, (v) => readRef(v) ?? fail());
    if (expiresAt !== undefined && expiresAt !== null) out.expiresAt = readDate(expiresAt);
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== 'string' || reason === '') throw new Malformed();
      out.reason = reason;
    }
    return Object.freeze({ ok: true, ceiling: Object.freeze(out) });
  } catch {
    return Object.freeze({ ok: false });
  }
}

/** `ancestors`: for a ref with an id, its ancestor list; ignored for a ref without id. */
export function ceilingOutcome(ceiling: unknown, permission: Permission, ref: ResourceRef, ancestors: readonly ResourceRef[] | undefined, now: Date): CeilingOutcome {
  const read = readCeiling(ceiling);
  if (!read.ok) return MALFORMED;
  const c = read.ceiling;
  if (c === undefined) return NO_CEILING;

  const target = readRef(ref);
  if (target === undefined) return MALFORMED;

  let failing = false;
  let restrict = TRUE;
  let expiresAt: Date | undefined;

  if (c.permissions !== undefined && !c.permissions.some((glob) => globMatches(glob, permission))) failing = true;

  if (c.expiresAt !== undefined) {
    const at = c.expiresAt.getTime();
    const nowAt = timeOf(now);
    if (Number.isNaN(at)) failing = true;
    else {
      expiresAt = Object.freeze(new Date(at));
      if (Number.isNaN(nowAt) || nowAt >= at) failing = true;
    }
  }

  if (c.resources !== undefined) {
    const entries = c.resources;
    if (target.id !== undefined) {
      const nodes = ancestorNodes(target, ancestors);
      if (nodes === undefined || !entries.some((e) => nodes.some((n) => scopeCovers(e, n)))) failing = true;
    } else if (target.type === GLOBAL.type) {
      // GLOBAL is a single known node, so decide statically instead of leaving an under() no row can match.
      if (!entries.some((e) => scopeCovers(e, GLOBAL))) failing = true;
    } else if (entries.length === 0) {
      failing = true;
    } else if (!entries.some((e) => scopeCovers(e, GLOBAL) || scopeCovers(e, { type: target.type }))) {
      restrict = Object.freeze({ op: 'under', scopes: entries });
    }
  }

  if (failing) {
    const denial = Object.freeze({ code: c.reason ?? 'ceiling', priority: PRIORITY });
    return Object.freeze(expiresAt ? { denials: Object.freeze([denial]), restrict: FALSE, expiresAt } : { denials: Object.freeze([denial]), restrict: FALSE });
  }
  return Object.freeze(expiresAt ? { denials: NO_CEILING.denials, restrict, expiresAt } : { denials: NO_CEILING.denials, restrict });
}

/** Denials concatenated, restrictions AND-ed, the earliest expiry. */
export function mergeCeilings(outcomes: readonly CeilingOutcome[]): CeilingOutcome {
  if (!Array.isArray(outcomes)) return MALFORMED;
  const denials: DenyReason[] = [];
  const restricts: ResourceFilter[] = [];
  let expiresAt: Date | undefined;
  for (const o of outcomes) {
    denials.push(...o.denials);
    restricts.push(o.restrict);
    if (o.expiresAt !== undefined && (expiresAt === undefined || o.expiresAt.getTime() < expiresAt.getTime())) expiresAt = o.expiresAt;
  }
  const restrict = denials.length > 0 ? FALSE : and(...restricts);
  const out: { -readonly [K in keyof CeilingOutcome]: CeilingOutcome[K] } = { denials: Object.freeze(denials), restrict };
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  return Object.freeze(out);
}

/** The `under` match rule: same type and (scope without id, or the same id); a null id is no id. */
export function scopeCovers(scope: ResourceRef, node: ResourceRef): boolean {
  const s = readRef(scope);
  const n = readRef(node);
  if (s === undefined || n === undefined || s.type !== n.type) return false;
  return s.id === undefined || s.id === n.id;
}

/** The ref itself, then its ancestors; the ref covers itself even when an adapter leaves it out. */
function ancestorNodes(target: ResourceRef, ancestors: readonly ResourceRef[] | undefined): ResourceRef[] | undefined {
  if (!Array.isArray(ancestors)) return undefined;
  try {
    const nodes = [target];
    const n = Math.min(ancestors.length, MAX_LIST);
    for (let i = 0; i < n; i++) {
      const ref = readRef(ancestors[i]);
      if (ref !== undefined) nodes.push(ref);
    }
    return nodes;
  } catch {
    return undefined;
  }
}

function globMatches(glob: string, permission: Permission): boolean {
  if (!isPermissionGlob(glob)) return false;
  try {
    return compilePermissionGlob(glob)(permission) === true;
  } catch {
    return false;
  }
}

/** A frozen `{ type, id? }` read once, or undefined when not ref-shaped. */
function readRef(v: unknown): ResourceRef | undefined {
  try {
    if (!isObject(v)) return undefined;
    const type = v.type;
    const id = v.id;
    if (typeof type !== 'string' || type === '') return undefined;
    if (id === undefined || id === null) return Object.freeze({ type });
    return typeof id === 'string' ? Object.freeze({ type, id }) : undefined;
  } catch {
    return undefined;
  }
}

function readStrings(v: unknown): readonly string[] {
  return readList(v, (x) => (typeof x === 'string' ? x : fail()));
}

function readList<T>(v: unknown, item: (x: unknown) => T): readonly T[] {
  if (!Array.isArray(v)) fail();
  const length = (v as unknown[]).length;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LIST) fail();
  const out: T[] = [];
  for (let i = 0; i < length; i++) out.push(item((v as unknown[])[i]));
  return Object.freeze(out);
}

/**
 * Invalid dates stay invalid (the expiry rule denies them); a non-Date is
 * malformed. The intrinsic getTime throws on an object that only inherits
 * from Date, and an own getTime override cannot lie about the instant.
 */
function readDate(v: unknown): Date {
  if (!(v instanceof Date)) fail();
  return Object.freeze(new Date(Date.prototype.getTime.call(v)));
}

function timeOf(d: unknown): number {
  try {
    return Date.prototype.getTime.call(d);
  } catch {
    return NaN;
  }
}

function fail(): never {
  throw new Malformed();
}
