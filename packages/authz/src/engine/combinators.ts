import { Combinator } from '../contracts/model.js';
import { FALSE, TRUE, and, not, or, simplify } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { CombiningAlgorithm, Vote } from '../contracts/decision.js';

export function normalizeVote(v: Vote): Vote {
  if (v.error === undefined) return v;

  const copy: { -readonly [K in keyof Vote]: Vote[K] } = { ...v, permitWhen: FALSE, denyWhen: TRUE };
  delete copy.denies;
  delete copy.fields;
  delete copy.roles;
  return Object.freeze(copy);
}

type Combined = { allow: ResourceFilter; deciding?: Vote };

export class DenyOverrides extends Combinator {
  readonly name: CombiningAlgorithm = 'deny-overrides';

  combine(votes: readonly Vote[]): Combined {
    const normalized = votes.map(normalizeVote);
    const allow = and(or(...normalized.map((v) => v.permitWhen)), not(or(...normalized.map((v) => v.denyWhen))));
    return Object.freeze({ allow: simplify(allow) });
  }
}

export class PermitOverrides extends Combinator {
  readonly name: CombiningAlgorithm = 'permit-overrides';

  combine(votes: readonly Vote[]): Combined {
    const allow = or(...votes.map(normalizeVote).map((v) => and(v.permitWhen, not(v.denyWhen))));
    return Object.freeze({ allow: simplify(allow) });
  }
}

export class FirstApplicable extends Combinator {
  readonly name: CombiningAlgorithm = 'first-applicable';

  combine(votes: readonly Vote[]): Combined {
    const terms: ResourceFilter[] = [];
    const inapplicable: ResourceFilter[] = [];
    let deciding: Vote | undefined;
    let decided = false;

    for (const vote of votes.map(normalizeVote)) {
      const applies = or(vote.permitWhen, vote.denyWhen);
      if (!decided && applies.op !== 'false') {
        decided = true;
        if (applies.op === 'true') deciding = vote;
      }

      terms.push(and(vote.permitWhen, not(vote.denyWhen), ...inapplicable));
      // Every later term carries not(TRUE) = FALSE, so they add nothing.
      if (applies.op === 'true') break;
      inapplicable.push(not(applies));
    }

    const allow = simplify(or(...terms));
    return Object.freeze(deciding === undefined ? { allow } : { allow, deciding });
  }
}

export const BUILTIN_COMBINATORS: readonly Combinator[] = Object.freeze([Object.freeze(new DenyOverrides()), Object.freeze(new PermitOverrides()), Object.freeze(new FirstApplicable())]);
