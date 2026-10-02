import { simplify } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import { compareDenyReasons } from '../contracts/decision.js';
import type { DenyReason, Vote } from '../contracts/decision.js';
import type { Truth } from './evaluate.js';
import { MAX_DATA_VALUES, validDate } from './vote.js';

/** Aligned with `vote.denies`. */
export interface VoteTruths {
  readonly permit: Truth;
  readonly denies: readonly Truth[];
}

export interface ReasonInput {
  /** Core denials and engine faults (`{ code: 'model_error' }` without model). */
  readonly core: readonly DenyReason[];
  /** Hygienic votes in evaluation order; indeterminate ones carry `error`. */
  readonly votes: readonly Vote[];
  readonly truths: readonly VoteTruths[];
  readonly algorithm: string;
  /** First-applicable only; one of `votes`, by identity. */
  readonly deciding?: Vote;
  /** A subject was given and its evaluation decided the denial. */
  readonly subjectEvaluated: boolean;
}

const MAX_DEPTH = 32;
const MODEL_ERROR = 'model_error';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

const isPlain = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function truthOf(f: unknown): Truth {
  if (!isObject(f)) return undefined;
  try {
    const op = simplify(f as unknown as ResourceFilter).op;
    return op === 'true' ? true : op === 'false' ? false : undefined;
  } catch {
    return undefined;
  }
}

const frozenTruths = (permit: Truth, denies: Truth[]): VoteTruths => Object.freeze({ permit, denies: Object.freeze(denies) });

function truthsOf(permitWhen: unknown, denies: unknown): VoteTruths {
  const out: Truth[] = [];
  if (Array.isArray(denies)) {
    for (let i = 0; i < denies.length; i++) {
      let truth: Truth;
      try {
        const entry: unknown = denies[i];
        truth = isObject(entry) ? truthOf(entry.when) : undefined;
      } catch {
        truth = undefined;
      }
      out.push(truth);
    }
  }
  return frozenTruths(truthOf(permitWhen), out);
}

/** Truths known without a subject: TRUE ⇒ true, FALSE ⇒ false, anything else ⇒ undefined (after simplify). */
export function staticTruths(vote: Vote): VoteTruths {
  try {
    if (!isObject(vote)) return frozenTruths(undefined, []);
    const v = vote as unknown as Record<string, unknown>;
    if (v.error !== undefined) return frozenTruths(false, []);
    const denies = v.denies;
    return truthsOf(v.permitWhen, denies);
  } catch {
    return frozenTruths(undefined, []);
  }
}

/** A caller-supplied truths entry, or undefined when it is not one. */
function suppliedTruths(raw: unknown): VoteTruths | undefined {
  try {
    if (!isObject(raw)) return undefined;
    const permit = raw.permit;
    const denies = raw.denies;
    if ((permit !== true && permit !== false && permit !== undefined) || !Array.isArray(denies)) return undefined;
    const out: Truth[] = [];
    for (let i = 0; i < denies.length; i++) {
      const t: unknown = denies[i];
      out.push(t === true ? true : t === false ? false : undefined);
    }
    return frozenTruths(permit, out);
  } catch {
    return undefined;
  }
}

class Overflow extends Error {}

/**
 * Plain-data copy, frozen: -0 becomes 0; values with no data form (functions,
 * symbols, bigints, class instances, cycles, too deep, invalid dates) are
 * dropped from objects and become null in arrays, as in JSON. Throws Overflow
 * past MAX_DATA_VALUES values, so shared subtrees cannot expand without bound.
 */
function copyValue(v: unknown, depth: number, path: Set<object>, values: { left: number }): unknown {
  if (--values.left < 0) throw new Overflow();
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Object.is(v, -0) ? 0 : v;
  if (!isObject(v) || depth > MAX_DEPTH || path.has(v)) return undefined;
  if (v instanceof Date) return validDate(v);
  path.add(v);
  try {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) out.push(copyValue(v[i], depth + 1, path, values) ?? null);
      return Object.freeze(out);
    }
    if (!isPlain(v)) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const item = copyValue(v[k], depth + 1, path, values);
      if (item !== undefined) define(out, k, item);
    }
    return Object.freeze(out);
  } finally {
    path.delete(v);
  }
}

// defineProperty: a '__proto__' key from parsed JSON stays an own data key instead of hitting the setter.
function define(o: Record<string, unknown>, k: string, value: unknown): void {
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Frozen copy of a reason, or undefined when it has no non-empty string code
 * or cannot be read (throwing getter, revoked proxy, over the value budget).
 * With `stamp`, the reason's own `model` is replaced.
 */
function copyReason(raw: unknown, stamp?: { readonly model: string | undefined }): DenyReason | undefined {
  try {
    if (!isObject(raw) || Array.isArray(raw) || !isPlain(raw)) return undefined;
    const out: Record<string, unknown> = {};
    const path = new Set<object>([raw]);
    const values = { left: MAX_DATA_VALUES };
    for (const k of Object.keys(raw)) {
      if (stamp && k === 'model') continue;
      const item = copyValue(raw[k], 1, path, values);
      if (item !== undefined) define(out, k, item);
    }
    if (typeof out.code !== 'string' || out.code === '') return undefined;
    if (stamp?.model !== undefined) define(out, 'model', stamp.model);
    return Object.freeze(out) as DenyReason;
  } catch {
    return undefined;
  }
}

// Unambiguous serialisation of a copied reason. Breaks ties that
// compareDenyReasons leaves (an explicit default priority, a Date against its
// ISO string), so equal keys mean deep-equal reasons (B36).
function canonical(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return `n${String(v)}`;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (v instanceof Date) return `d${Date.prototype.getTime.call(v)}`;
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/** An unreadable element is undefined, so it is skipped (core) or a fault (votes) wherever it stands. */
function readAt(list: readonly unknown[], i: number): unknown {
  try {
    return list[i];
  } catch {
    return undefined;
  }
}

const modelError = (model: string | undefined): DenyReason => Object.freeze(model === undefined ? { code: MODEL_ERROR } : { code: MODEL_ERROR, model });

/** The reported deny reason: the minimum of the candidates under `compareDenyReasons` (conventions, "Reasons"). */
export function selectDenyReason(input: ReasonInput): DenyReason {
  const candidates: DenyReason[] = [];
  let fault = false;
  let subjectEvaluated = false;

  try {
    const { core, votes, truths, algorithm, deciding } = input;
    subjectEvaluated = input.subjectEvaluated === true;

    if (Array.isArray(core)) {
      for (let i = 0; i < core.length; i++) {
        const reason = copyReason(readAt(core, i));
        if (reason) candidates.push(reason);
      }
    } else fault = true;

    if (Array.isArray(votes)) {
      const supplied: readonly unknown[] = Array.isArray(truths) ? truths : [];
      const list: unknown[] = [];
      for (let i = 0; i < votes.length; i++) list.push(readAt(votes, i));
      const counted: readonly (readonly [unknown, number])[] = algorithm === 'first-applicable' && deciding !== undefined ? [[deciding, list.indexOf(deciding)]] : list.map((v, i) => [v, i] as const);
      for (const [vote, i] of counted) {
        if (!countVote(vote, i >= 0 ? readAt(supplied, i) : undefined, subjectEvaluated, candidates)) fault = true;
      }
    } else fault = true;
  } catch {
    fault = true;
  }

  if (fault) candidates.push(modelError(undefined));
  if (candidates.length === 0) return Object.freeze({ code: subjectEvaluated ? 'residual_false' : 'no_access' });

  let best = candidates[0];
  let bestKey: string | undefined;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const order = compareDenyReasons(c, best);
    if (order > 0) continue;
    if (order === 0) {
      const key = canonical(c);
      bestKey ??= canonical(best);
      if (key >= bestKey) continue;
      best = c;
      bestKey = key;
      continue;
    }
    best = c;
    bestKey = undefined;
  }
  return best;
}

function reasonOf(entry: unknown): unknown {
  try {
    return isObject(entry) ? entry.reason : undefined;
  } catch {
    return undefined;
  }
}

/** Adds the candidates of one vote; false when the vote cannot be read. */
function countVote(vote: unknown, suppliedRaw: unknown, subjectEvaluated: boolean, out: DenyReason[]): boolean {
  if (!isObject(vote)) return false;
  try {
    const name = typeof vote.model === 'string' && vote.model !== '' ? vote.model : undefined;
    const error = vote.error;
    if (error !== undefined) {
      out.push(modelError(name));
      return true;
    }
    const denies = vote.denies;
    const reason = vote.reason;
    const truths = suppliedTruths(suppliedRaw) ?? truthsOf(vote.permitWhen, denies);
    const stamp = { model: name };

    if (Array.isArray(denies)) {
      for (let j = 0; j < denies.length; j++) {
        if (truths.denies[j] !== true) continue;
        const copy = copyReason(reasonOf(readAt(denies, j)), stamp);
        if (copy) out.push(copy);
      }
    }
    if (reason !== undefined && (truths.permit === false || (truths.permit === undefined && subjectEvaluated))) {
      const copy = copyReason(reason, stamp);
      if (copy) out.push(copy);
    }
    return true;
  } catch {
    return false;
  }
}
