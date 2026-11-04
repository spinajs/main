import type { DenyReason, Vote } from '../../contracts/decision.js';
import { selectDenyReason } from '../reasons.js';
import type { VoteTruths } from '../reasons.js';
import { ENGINE_FAULT } from '../types.js';

/** `subjectEvaluated`: the subject itself denied (only then `residual_false`, B36). */
export function denyReason(core: readonly DenyReason[], votes: readonly Vote[], truths: readonly VoteTruths[], deciding: Vote | undefined, algorithm: string, subjectEvaluated: boolean, engineFault: boolean): DenyReason {
  return selectDenyReason({ core: engineFault ? [...core, ENGINE_FAULT] : core, votes, truths, algorithm, deciding, subjectEvaluated });
}
