import { AuthzConfigError } from '../contracts/errors.js';
import { FALSE, TRUE, and, not, or, simplify } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { DenyReason } from '../contracts/decision.js';
import { SYSTEM, UNATTENDED, principalKey } from '../contracts/principal.js';
import type { Ceiling, Principal } from '../contracts/principal.js';
import { DENY_ALL_CEILING, readCeiling } from './ceiling.js';

export interface Delegation {
  /** Who the models run with. */
  readonly principal: Principal;
  /** The agent under inherit, else the request's actor. */
  readonly actor?: Principal;
  /** Every ceiling to apply: the request principal's and each inherit delegate's, as validated copies. */
  readonly ceilings: readonly unknown[];
  /** Delegate whose decision must also allow (a nested check by the engine). */
  readonly intersect?: Principal;
  /** principalKey of `intersect`, from the same read as the copy. */
  readonly intersectKey?: string;
  /** Set for a forbidden or unreadable delegate: the decision is denied. */
  readonly denial?: DenyReason;
  /** The request principal and every onBehalfOf (originals), for tags and preload. */
  readonly chain: readonly Principal[];
  /** Hops up to and including the intersected delegate (all hops without one); its nested check gets `max - hopsUsed`. */
  readonly hopsUsed: number;
}

const PRIORITY = 200;
const MAX_FILTER_DEPTH = 256;
const MAX_ARGS = 100_000;
const CHAIN_KEYS = new Set(['type', 'id', 'onBehalfOf', 'delegation', 'ceiling']);

type Identity = { readonly type: string; readonly id: string };

/** A principal's chain fields, each read once. `ceiling` is undefined when absent or malformed (`ceilingOk` tells which). */
type Snapshot = { readonly ok: false; readonly who?: Identity } | { readonly ok: true; readonly who: Identity; readonly onBehalfOf: unknown; readonly delegation: unknown; readonly ceiling?: Ceiling; readonly ceilingOk: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const present = (v: unknown): boolean => v !== undefined && v !== null;

function identity(p: unknown): Identity | undefined {
  try {
    if (!isObject(p)) return undefined;
    const type = p.type;
    const id = p.id;
    return typeof type === 'string' && type !== '' && typeof id === 'string' ? { type, id } : undefined;
  } catch {
    return undefined;
  }
}

function snapshot(p: unknown): Snapshot {
  const who = identity(p);
  if (who === undefined) return { ok: false };
  try {
    const o = p as Record<string, unknown>;
    const onBehalfOf = o.onBehalfOf;
    const delegation = o.delegation;
    const read = readCeiling(o.ceiling);
    return read.ok ? { ok: true, who, onBehalfOf, delegation, ceiling: read.ceiling, ceilingOk: true } : { ok: true, who, onBehalfOf, delegation, ceilingOk: false };
  } catch {
    return { ok: false, who };
  }
}

const forbiddenType = (who: Identity): boolean => who.type === 'system' || who.type === 'unattended';

function delegateDenial(who: Identity | undefined): DenyReason {
  return Object.freeze(who === undefined ? { code: 'delegate', priority: PRIORITY } : { code: 'delegate', priority: PRIORITY, delegate: principalKey(who) });
}

/** The ceiling the engine applies: an unreadable one still denies. */
const appliedCeiling = (s: Snapshot & { ok: true }): Ceiling | undefined => (s.ceilingOk ? s.ceiling : DENY_ALL_CEILING);

/** Roles a principal's ceiling allows: undefined = unrestricted; a malformed ceiling allows none. */
const rolesOf = (s: Snapshot & { ok: true }): readonly string[] | undefined => (s.ceilingOk ? s.ceiling?.roles : Object.freeze([]));

function intersectRoles(delegate: readonly string[] | undefined, agent: readonly string[] | undefined): readonly string[] | undefined {
  if (delegate === undefined) return agent;
  if (agent === undefined) return delegate;
  const allowed = new Set(agent);
  return Object.freeze([...new Set(delegate)].filter((r) => allowed.has(r)));
}

function copyPrincipal(source: Record<string, unknown>, s: Snapshot & { ok: true }, roles: readonly string[] | undefined): Principal {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(source)) if (!CHAIN_KEYS.has(k)) define(out, k, source[k]);
  define(out, 'type', s.who.type);
  define(out, 'id', s.who.id);
  if (s.onBehalfOf !== undefined) define(out, 'onBehalfOf', s.onBehalfOf);
  if (s.delegation !== undefined) define(out, 'delegation', s.delegation);
  const base = appliedCeiling(s);
  if (base !== undefined || roles !== undefined) {
    const ceiling: { -readonly [K in keyof Ceiling]: Ceiling[K] } = { ...base };
    if (roles !== undefined) ceiling.roles = roles;
    // Freezing does not stop setTime: the copy handed to models must not share the instant the engine applies.
    if (base?.expiresAt !== undefined) ceiling.expiresAt = new Date(base.expiresAt.getTime());
    define(out, 'ceiling', Object.freeze(ceiling));
  }
  return Object.freeze(out) as unknown as Principal;
}

// defineProperty: a '__proto__' key from parsed JSON stays an own data key instead of hitting the setter.
function define(o: Record<string, unknown>, k: string, value: unknown): void {
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });
}

/** Throws AuthzConfigError when the onBehalfOf chain (a cycle counts as endless) is deeper than `maxDelegation`. */
export function resolveDelegation(principal: Principal, actor: Principal | undefined, maxDelegation: number): Delegation {
  if (typeof maxDelegation !== 'number' || !Number.isInteger(maxDelegation) || maxDelegation < 0) throw new AuthzConfigError(`maxDelegation must be an integer >= 0, got ${String(maxDelegation)}`);

  const chain: Principal[] = [principal];
  const ceilings: Ceiling[] = [];
  const seen = new Set<unknown>([principal]);
  let hops = 0;
  let runAs = principal;
  let runActor = actor;

  const result = (extra: { intersect?: Principal; intersectKey?: string; denial?: DenyReason; hopsUsed?: number } = {}): Delegation => {
    const out: { -readonly [K in keyof Delegation]: Delegation[K] } = { principal: runAs, ceilings: Object.freeze(ceilings), chain: Object.freeze(chain), hopsUsed: extra.hopsUsed ?? hops };
    if (runActor !== undefined) out.actor = runActor;
    if (extra.intersect !== undefined) out.intersect = extra.intersect;
    if (extra.intersectKey !== undefined) out.intersectKey = extra.intersectKey;
    if (extra.denial !== undefined) out.denial = extra.denial;
    return Object.freeze(out);
  };

  const hop = (next: unknown): { readonly snap: Snapshot & { ok: true } } | { readonly denial: DenyReason } => {
    hops++;
    if (hops > maxDelegation) throw new AuthzConfigError(`the onBehalfOf chain is deeper than maxDelegation (${maxDelegation})`);
    if (seen.has(next)) throw new AuthzConfigError('the onBehalfOf chain has a cycle');
    seen.add(next);
    const s = snapshot(next);
    if (next === SYSTEM || next === UNATTENDED || !s.ok || forbiddenType(s.who)) return { denial: delegateDenial(s.who) };
    chain.push(next as Principal);
    return { snap: s };
  };

  const root = snapshot(principal);
  if (!root.ok) return result({ denial: delegateDenial(undefined) });
  const rootCeiling = appliedCeiling(root);
  if (rootCeiling !== undefined) ceilings.push(rootCeiling);

  let cur: Snapshot & { ok: true } = root;
  let roles = rolesOf(root);
  while (present(cur.onBehalfOf) && cur.delegation === 'inherit') {
    const next = cur.onBehalfOf;
    const step = hop(next);
    if ('denial' in step) return result(step);
    const s = step.snap;
    const applied = appliedCeiling(s);
    if (applied !== undefined) ceilings.push(applied);
    roles = intersectRoles(rolesOf(s), roles);
    try {
      runAs = copyPrincipal(next as Record<string, unknown>, s, roles);
    } catch {
      return result({ denial: delegateDenial(s.who) });
    }
    runActor = actor ?? principal;
    cur = s;
  }

  if (!present(cur.onBehalfOf)) return result();

  const first = hop(cur.onBehalfOf);
  if ('denial' in first) return result(first);
  const hopsUsed = hops;
  let delegate: Principal;
  try {
    delegate = copyPrincipal(cur.onBehalfOf as Record<string, unknown>, first.snap, undefined);
  } catch {
    return result({ denial: delegateDenial(first.snap.who), hopsUsed });
  }

  // The nested check resolves the rest itself; walking it here keeps one
  // depth budget for the whole chain and puts every link into `chain`.
  let rest = first.snap;
  while (present(rest.onBehalfOf)) {
    const step = hop(rest.onBehalfOf);
    if ('denial' in step) return result({ denial: step.denial, hopsUsed });
    rest = step.snap;
  }
  return result({ intersect: delegate, intersectKey: principalKey(first.snap.who), hopsUsed });
}

/**
 * `relation` and `native:*` nodes mean "the current principal", which SQL and
 * the subject evaluator read as the request principal; in a delegate's residual
 * they are replaced fail-closed: FALSE under an even number of `not`s, TRUE
 * under an odd one. Malformed, unknown or too deep nodes are replaced the same
 * way. A `native:*` op listed in `keep` is kept as is under either polarity:
 * the Authorizer lists the ops whose NativeFilter declares `principalInArgs`,
 * whose args name the delegate, so they mean the same for whoever evaluates
 * them. Memoised per node and polarity (one `keep` per call), so shared
 * subtrees cost once.
 */
export function stripPrincipalOps(f: ResourceFilter, keep?: ReadonlySet<string>): ResourceFilter {
  const memo: StripState = { keep, byPolarity: [new WeakMap(), new WeakMap()] };
  try {
    return simplify(strip(f, false, 1, memo));
  } catch {
    return FALSE;
  }
}

type StripState = { readonly keep: ReadonlySet<string> | undefined; readonly byPolarity: [WeakMap<object, ResourceFilter>, WeakMap<object, ResourceFilter>] };

function strip(f: unknown, negated: boolean, depth: number, memo: StripState): ResourceFilter {
  const missing = negated ? TRUE : FALSE;
  if (!isObject(f) || depth > MAX_FILTER_DEPTH) return missing;
  const cache = memo.byPolarity[negated ? 1 : 0];
  const hit = cache.get(f);
  if (hit !== undefined) return hit;

  let out: ResourceFilter;
  try {
    const op = f.op;
    if (op === 'and' || op === 'or') {
      const args = f.args;
      const length = Array.isArray(args) ? args.length : -1;
      if (length < 0 || length > MAX_ARGS) out = missing;
      else {
        const parts: ResourceFilter[] = [];
        for (let i = 0; i < length; i++) parts.push(strip((args as unknown[])[i], negated, depth + 1, memo));
        out = op === 'and' ? and(...parts) : or(...parts);
      }
    } else if (op === 'not') out = not(strip(f.arg, !negated, depth + 1, memo));
    else if (op === 'true') out = TRUE;
    else if (op === 'false') out = FALSE;
    else if (op === 'cmp' || op === 'under') out = f as ResourceFilter;
    else if (typeof op === 'string' && op.startsWith('native:') && memo.keep?.has(op) === true) out = f as ResourceFilter;
    else out = missing;
  } catch {
    out = missing;
  }
  cache.set(f, out);
  return out;
}
