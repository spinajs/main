import { AuthzConfigError } from '../contracts/errors.js';
import { FALSE, TRUE, and, not, or, simplify } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import { normalizeFieldGlobs, subtractFieldGlobs, unionFieldGlobs } from '../contracts/fields.js';
import type { Vote } from '../contracts/decision.js';
import { describeError } from './vote.js';

export interface FieldResult {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

const ALL: readonly string[] = Object.freeze(['*']);
const NONE: FieldResult = Object.freeze({ read: Object.freeze([]), write: Object.freeze([]) });
// The contract's per-list limit, checked here so an oversized list never becomes a memo key.
const MAX_GLOBS = 1000;
const MAX_MEMO_KEY = 64 * 1024;

type Outcome = { readonly ok: FieldResult } | { readonly error: AuthzConfigError };

const result = (read: string[], write: string[]): FieldResult => Object.freeze({ read: Object.freeze(read), write: Object.freeze(write) });

const identity = (f: ResourceFilter): ResourceFilter => f;

// Checked before the memo key is built: JSON alone would not tell 1 from '1'.
function globList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) throw new AuthzConfigError(`${where} is not a list of field globs`);
  if (v.length > MAX_GLOBS) throw new AuthzConfigError(`${where} has ${v.length} field globs (at most ${MAX_GLOBS})`);
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const item: unknown = i in v ? v[i] : undefined;
    if (typeof item !== 'string') throw new AuthzConfigError(`${where}[${i}] is not a string`);
    out.push(item);
  }
  return out;
}

export class FieldCombiner {
  private readonly neverRead: readonly string[];
  private readonly memoSize: number;
  private readonly memo = new Map<string, Outcome>();

  constructor(options: { neverRead: readonly string[]; memoSize?: number }) {
    const neverRead = globList(options.neverRead, 'neverRead');
    normalizeFieldGlobs(neverRead);
    this.neverRead = Object.freeze(neverRead);
    const memoSize = options.memoSize ?? 1000;
    if (!Number.isSafeInteger(memoSize) || memoSize < 0) throw new AuthzConfigError(`memoSize must be a non-negative integer, got ${String(memoSize)}`);
    this.memoSize = memoSize;
  }

  /**
   * Hygienic votes in evaluation order; `bind` is the request's ref binder (terms are judged after binding).
   * Votes past the deciding one are ignored, so explain and check yield the same fields. Throws AuthzConfigError.
   */
  combine(algorithm: string, votes: readonly Vote[], bind: (f: ResourceFilter) => ResourceFilter = identity): FieldResult {
    const bound = (f: ResourceFilter): ResourceFilter => {
      try {
        return simplify(bind(f));
      } catch (e) {
        throw new AuthzConfigError(`binding refs for fields failed: ${describeError(e)}`, { cause: e });
      }
    };
    const reads: string[][] = [];
    const writes: string[][] = [];
    const hides: string[][] = [];
    // first-applicable: AND of not(P_j or D_j) over the earlier votes, indeterminate ones counting as always applicable.
    let unapplied: ResourceFilter = TRUE;

    for (const vote of votes) {
      const indeterminate = vote.error !== undefined;
      const permitWhen = indeterminate ? FALSE : simplify(vote.permitWhen);
      const denyWhen = indeterminate ? TRUE : simplify(vote.denyWhen);
      if (!indeterminate) {
        const fields = vote.fields;
        const term = algorithm === 'permit-overrides' ? and(permitWhen, not(denyWhen)) : algorithm === 'first-applicable' ? and(permitWhen, not(denyWhen), unapplied) : permitWhen;
        if (term.op !== 'false' && bound(term).op !== 'false') {
          const read = fields?.read;
          const write = fields?.write;
          reads.push(read === undefined ? [...ALL] : globList(read, `${vote.model}: fields.read`));
          writes.push(write === undefined ? [...ALL] : globList(write, `${vote.model}: fields.write`));
        }
        const hide = fields?.hide;
        if (hide !== undefined && denyWhen.op !== 'false' && bound(not(denyWhen)).op !== 'true') hides.push(globList(hide, `${vote.model}: fields.hide`));
      }
      // Same stop rule as the engine's short-circuit, judged on the unbound vote as the engine judges it.
      if (algorithm === 'permit-overrides' && and(permitWhen, not(denyWhen)).op === 'true') break;
      if (algorithm === 'first-applicable') {
        const applies = or(permitWhen, denyWhen);
        if (applies.op === 'true') break;
        unapplied = and(unapplied, not(applies));
      }
    }

    if (reads.length === 0) return NONE;
    return this.memoised(JSON.stringify([reads, writes, hides]), () => {
      const removed = unionFieldGlobs(...hides, this.neverRead);
      return result(subtractFieldGlobs(unionFieldGlobs(...reads), removed), subtractFieldGlobs(unionFieldGlobs(...writes), removed));
    });
  }

  /** a ∩ b as a − (a − b) with the contract's exact subtract; for intersect delegation. */
  intersect(a: FieldResult, b: FieldResult): FieldResult {
    const ar = globList(a.read, 'read');
    const aw = globList(a.write, 'write');
    const br = globList(b.read, 'read');
    const bw = globList(b.write, 'write');
    const both = (x: string[], y: string[]) => subtractFieldGlobs(x, subtractFieldGlobs(x, y));
    return this.memoised(`&${JSON.stringify([ar, aw, br, bw])}`, () => result(both(ar, br), both(aw, bw)));
  }

  private memoised(key: string, compute: () => FieldResult): FieldResult {
    if (key.length > MAX_MEMO_KEY) return compute();
    const known = this.memo.get(key);
    if (known !== undefined) {
      this.memo.delete(key);
      this.memo.set(key, known);
      if ('error' in known) throw known.error;
      return known.ok;
    }

    let outcome: Outcome;
    try {
      outcome = { ok: compute() };
    } catch (e) {
      if (!(e instanceof AuthzConfigError)) throw e;
      outcome = { error: e };
    }
    if (this.memoSize > 0) {
      this.memo.set(key, outcome);
      if (this.memo.size > this.memoSize) this.memo.delete(this.memo.keys().next().value!);
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.ok;
  }
}
