import { FALSE, and, not, or } from '../../contracts/filter.js';
import type { Decision, DenyReason, Vote } from '../../contracts/decision.js';
import type { AuthorizationModel, NativeFilter } from '../../contracts/model.js';
import type { Principal, PrincipalRef, ResourceRef, ResourceType } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import { principalState } from '../cache-key.js';
import { normalizeVote } from '../combinators.js';
import type { ModelContext } from '../context.js';
import { isObject } from '../internal/util.js';
import { deepFreeze, validDate } from '../vote.js';
import { NO_FIELDS, byName } from '../types.js';
import type { Nested, RequestScope, Run } from '../types.js';

export const scopeMap = (scope: RequestScope | undefined): Map<string, unknown> => (scope?.cache instanceof Map ? scope.cache : new Map<string, unknown>());

export const newNested = (): Nested => ({ uncacheable: false, untagged: false, faulted: false, tags: new Set() });

/** Only a top-level check outside summary/covers is an access attempt. */
export const audits = (run: Run): boolean => run.depth === 0 && run.quiet !== true;

/** undefined tags: no invalidate can reach a decision above this one in the L2, so it stays in the L1 (which the generation guards). */
export function nest(run: Run, tags: readonly string[] | undefined): void {
  if (tags === undefined) run.nested.untagged = true;
  else for (const t of tags) run.nested.tags.add(t);
}

export function once<T>(f: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = f();
      done = true;
    }
    return value;
  };
}

export const principalRef = (p: PrincipalRef): PrincipalRef => Object.freeze({ type: p.type, id: p.id });

const principalObjects = new WeakMap<object, number>();
let nextPrincipalObject = 0;

/**
 * ctx.cache is per model and per full state of the principal the
 * models run with, not per type:id: a narrowed inherit copy differs from its
 * delegate only in ceiling.roles. A principal with no canonical state gets a
 * key of its own object.
 */
export function principalCacheId(p: Principal): string {
  const state = principalState(p);
  if (state !== undefined) return `state:${state}`;
  let n = principalObjects.get(p);
  if (n === undefined) {
    n = nextPrincipalObject++;
    principalObjects.set(p, n);
  }
  return `object:${n}`;
}

// Duck-typed and read once: a filter from a second copy of this package, or a throwing getter (undeclared, so stripped).
export function declaresPrincipalInArgs(filter: NativeFilter): boolean {
  try {
    return filter.principalInArgs === true;
  } catch {
    return false;
  }
}

/** The subject evaluator reads a native filter's throw as UNKNOWN, not a fault, so nothing else drops what it memoised before throwing. */
export function detachingOnThrow(filter: NativeFilter, ctx: ModelContext): NativeFilter {
  const detach = (e: unknown): never => {
    ctx.detachMemo();
    throw e;
  };
  return {
    op: filter.op,
    matches: (args, subject, ref, c) => {
      let out: boolean | Promise<boolean>;
      try {
        out = filter.matches(args, subject, ref, c);
      } catch (e) {
        return detach(e);
      }
      return Promise.resolve(out).catch(detach);
    },
  };
}

/** `hook`: a model hook with a memo of its own (summarize), apart from the votes' one. */
export const contextCacheKey = (owner: string, cacheId: string, hook?: string): string => JSON.stringify(hook === undefined ? [cacheId, owner] : [cacheId, owner, hook]);

/** Exactly `{ type, id? }` as own data properties; `id: null` = no id. */
export function refShaped(v: object): ResourceRef | undefined {
  if (Reflect.ownKeys(v).some((k) => k !== 'type' && k !== 'id')) return undefined;
  const type = Object.getOwnPropertyDescriptor(v, 'type');
  if (!type || !('value' in type) || typeof type.value !== 'string' || type.value === '') return undefined;
  const id = Object.getOwnPropertyDescriptor(v, 'id');
  if (id === undefined || ('value' in id && id.value === null)) return Object.freeze({ type: type.value });
  return 'value' in id && typeof id.value === 'string' ? Object.freeze({ type: type.value, id: id.value }) : undefined;
}

export function capabilitiesOf(model: AuthorizationModel): { readonly effects?: unknown; readonly residuals?: unknown } {
  try {
    const caps: unknown = model.capabilities;
    return isObject(caps) ? { effects: caps.effects, residuals: caps.residuals } : {};
  } catch {
    return {};
  }
}

export function syncMode(model: AuthorizationModel): unknown {
  try {
    return model.capabilities.sync;
  } catch {
    return 'never';
  }
}

// Skipping drops a model's denies too, so only a well-formed principalTypes list that lacks the type skips.
export function admits(model: AuthorizationModel, principal: Principal): boolean {
  try {
    const types: unknown = model.capabilities.principalTypes;
    return !Array.isArray(types) || types.includes(principal.type);
  } catch {
    return true;
  }
}

export function decides(algorithm: string, vote: Vote): boolean {
  const v = normalizeVote(vote);
  return (algorithm === 'permit-overrides' ? and(v.permitWhen, not(v.denyWhen)) : or(v.permitWhen, v.denyWhen)).op === 'true';
}

export function mergeRoles(votes: readonly Vote[]): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const vote of votes.filter((v) => v.error === undefined && v.roles !== undefined).sort(byName)) {
    for (const [ladder, role] of Object.entries(vote.roles!)) {
      if (!Object.hasOwn(merged, ladder)) Object.defineProperty(merged, ladder, { value: role, enumerable: true, writable: true, configurable: true });
    }
  }
  return Object.freeze(merged);
}

/** Freezing does not stop setTime: the store and every cache hit get their own validUntil, so no caller can move another's. */
export function withOwnDate(d: Decision): Decision {
  const until = validDate(d.validUntil);
  return until === undefined ? d : Object.freeze({ ...d, validUntil: until });
}

export function earliest(dates: readonly (Date | undefined)[]): Date | undefined {
  let best: Date | undefined;
  for (const d of dates) {
    const valid = validDate(d);
    if (valid && (best === undefined || valid.getTime() < best.getTime())) best = valid;
  }
  return best;
}

/** Distinct refs (by resourceKey) grouped by type, in first-seen order. */
export function byType(refs: readonly ResourceRef[]): Map<ResourceType, ResourceRef[]> {
  const out = new Map<ResourceType, ResourceRef[]>();
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = resourceKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = out.get(ref.type);
    if (list) list.push(ref);
    else out.set(ref.type, [ref]);
  }
  return out;
}

/** A conditional decision whose row could not be read, denied the way authz-http's subject loading denies it. */
export function deniedCopy(d: Decision, reason: DenyReason): Decision {
  return deepFreeze({ ...d, allowed: false, residual: FALSE, fields: NO_FIELDS, reason: { ...reason } });
}
