import type { ReplayDivergence, ReplayMissing, ReplayReport } from '@spinajs/authz';

import type { Truth } from '../eval/explain.js';

/**
 * The reason a ReBAC vote left undecided only by caveats is recorded with: a definite no-permit for the engine,
 * `unknown` for the IR. `voteTruth` of the test kit reads it the same way; authz-ir cannot import it.
 */
export const CAVEAT_UNKNOWN = 'caveat_unknown';

export interface VerdictInput {
  recorded: { allowed: boolean; reason?: string; cached: boolean };
  /** Rules 1 and 2: what the record or the policy version lacks; anything here stops the replay before it evaluates. */
  blocked: readonly ReplayMissing[];
  /** Rule 3: the stored IR hashes to `replayed`. */
  policyHash?: { recorded: string; replayed: string };
  /** The replayed truth; null when nothing was evaluated. */
  truth: Truth | null;
  /** Rule 4: what left the truth unknown (gap reads, opaque terms, caveat parameters, limits, budgets). */
  unknowns: readonly ReplayMissing[];
  /** Rule 6, with captured inputs only. */
  inputsHash?: { recorded: string; replayed: string };
  captured?: readonly ReplayDivergence[];
}

type Verdict = Pick<ReplayReport, 'replay' | 'evidence' | 'missing' | 'divergence'>;

const unreplayable = (missing: readonly ReplayMissing[]): Verdict => ({ replay: 'unreplayable', missing: [...missing], divergence: [] });
const divergent = (divergence: readonly ReplayDivergence[]): Verdict => ({ replay: 'divergent', missing: [], divergence: [...divergence] });

/**
 * The verdict, by rules applied in order, so an incomplete replay is never divergent:
 * 1-2. the record or the policy version lacks something: unreplayable;
 * 3. the stored IR does not hash to the record's policy hash: divergent;
 * 4. the replayed truth is unknown, or the record denied on caveats it could not decide: unreplayable;
 * 5. the replayed truth differs from the recorded outcome: divergent;
 * 6. with captured inputs, the recomputed inputs hash or a rebuilt captured value differs: divergent;
 * 7. otherwise faithful, with the evidence it rests on.
 */
export function replayVerdict(input: VerdictInput): Verdict {
  if (input.blocked.length > 0) return unreplayable(input.blocked);
  if (input.policyHash !== undefined && input.policyHash.recorded !== input.policyHash.replayed) return divergent([{ part: 'policy-hash', ...input.policyHash }]);
  const recordedUnknown = !input.recorded.allowed && input.recorded.reason === CAVEAT_UNKNOWN;
  if (input.truth === null || input.truth === 'unknown' || recordedUnknown) return undetermined(input, recordedUnknown);
  return compared(input, input.truth);
}

/** Rule 4. */
function undetermined(input: VerdictInput, recordedUnknown: boolean): Verdict {
  const missing = [...input.unknowns];
  if (recordedUnknown) missing.push({ input: CAVEAT_UNKNOWN, reason: 'the decision denied on caveats it could not decide' });
  if (missing.length === 0) missing.push({ input: 'evaluation', reason: 'the replay did not evaluate the decision' });
  return unreplayable(missing);
}

/** Rules 5 to 7. */
function compared(input: VerdictInput, truth: 'allow' | 'deny'): Verdict {
  const recorded = input.recorded.allowed ? 'allow' : 'deny';
  if (truth !== recorded) return divergent([{ part: 'outcome', recorded: input.recorded.cached ? `${recorded} (cached)` : recorded, replayed: truth }]);
  const divergence: ReplayDivergence[] = [];
  if (input.inputsHash !== undefined && input.inputsHash.recorded !== input.inputsHash.replayed) divergence.push({ part: 'inputs-hash', ...input.inputsHash });
  divergence.push(...(input.captured ?? []));
  if (divergence.length > 0) return divergent(divergence);
  return { replay: 'faithful', evidence: input.inputsHash === undefined ? 'outcome' : 'inputs-hash', missing: [], divergence: [] };
}
