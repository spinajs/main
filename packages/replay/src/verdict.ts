import type { ReplayDivergence, ReplayMissing, ReplayOutcome, ReplayReport } from './contracts.js';
import { sameImage } from './history.js';

export type ReplayVerdictResult = Pick<ReplayReport, 'replay' | 'evidence' | 'missing' | 'divergences'>;

const NOT_EVALUATED: ReplayMissing = { input: 'evaluation', reason: 'the replay did not evaluate the recording' };

const unreplayable = (missing: readonly ReplayMissing[]): ReplayVerdictResult => ({ replay: 'unreplayable', missing: missing.length > 0 ? [...missing] : [NOT_EVALUATED], divergences: [] });
const divergent = (divergences: readonly ReplayDivergence[]): ReplayVerdictResult => ({ replay: 'divergent', missing: [], divergences: [...divergences] });

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

/**
 * The verdict rules of section 10, in order, so that an incomplete replay is divergent only where an artifact proves
 * it: 2. a missing input `artifact:<kind>`; 3. a divergence `artifact-hash`; 4. an `unknown` outcome, every gap named;
 * 5. an outcome other than the recorded one, on the outcome alone; 6. a divergence the replayer reports; 7. faithful.
 * Rule 1, a recording that cannot be read, arrives as an `unknown` outcome. Rule 7 drops `missing`: an outcome other
 * than `unknown` asserts that none of it could change the answer (`ReplayOutcome`).
 */
export function verdictOf(recorded: unknown, o: ReplayOutcome): ReplayVerdictResult {
  if (o.missing.some((m) => m.input.startsWith('artifact:'))) return unreplayable(o.missing);
  const artifacts = o.divergences.filter((d) => d.part === 'artifact-hash');
  if (artifacts.length > 0) return divergent(artifacts);
  if (o.outcome === 'unknown') return unreplayable(o.missing);
  if (!sameImage(recorded, o.outcome)) return divergent([{ part: 'outcome', recorded: textOf(recorded), replayed: textOf(o.outcome) }]);
  if (o.divergences.length > 0) return divergent(o.divergences);
  return { replay: 'faithful', evidence: o.evidence ?? 'outcome', missing: [], divergences: [] };
}
