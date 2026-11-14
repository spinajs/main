import type { CombineEntryIR, CombineIR, RelationName, Rewrite, TypeName } from '../ir.js';

/** One model's say on a permission: the relations that permit and deny it. */
export interface ModelVote {
  model: string;
  permit?: RelationName;
  deny?: RelationName;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const NEVER: Rewrite = { priority: [] };
const anyOf = (items: Rewrite[]): Rewrite => (items.length === 0 ? NEVER : items.length === 1 ? items[0] : { union: items });

/** The route `authz.combine` gives a resource type (`authz/src/engine/routes.ts`): its own entry, else the default. */
export function routeFor(combine: CombineIR, type: TypeName): CombineEntryIR {
  return combine.types !== undefined && own(combine.types, type) ? combine.types[type] : combine.default;
}

/** The votes the route lets speak, in its `models` order when it names them. */
export function votersOf(entry: CombineEntryIR, votes: readonly ModelVote[]): ModelVote[] {
  if (entry.models === undefined) return [...votes];
  return entry.models.flatMap((m) => votes.filter((v) => v.model === m));
}

/**
 * The G5 encodings of the built-in combinators (`authz/src/engine/combinators.ts`): deny-overrides is
 * `exclusion(∪ permit, ∪ deny)`, permit-overrides `∪_m exclusion(permit_m, deny_m)`, first-applicable a
 * priority chain where each model's deny comes before its permit. A custom combinator is opaque.
 */
export function combineVotes(entry: CombineEntryIR, votes: readonly ModelVote[]): Rewrite {
  const voters = votersOf(entry, votes);
  const algorithm = entry.algorithm;
  if (typeof algorithm !== 'string') return { opaque: `combinator ${algorithm.opaque}` };
  switch (algorithm) {
    case 'deny-overrides': {
      const permits = voters.flatMap((v) => (v.permit === undefined ? [] : [{ computed: v.permit }]));
      const denies = voters.flatMap((v) => (v.deny === undefined ? [] : [{ computed: v.deny }]));
      return permits.length === 0 || denies.length === 0 ? anyOf(permits) : { exclusion: { base: anyOf(permits), subtract: anyOf(denies) } };
    }
    case 'permit-overrides':
      return anyOf(voters.flatMap((v) => (v.permit === undefined ? [] : [v.deny === undefined ? { computed: v.permit } : { exclusion: { base: { computed: v.permit }, subtract: { computed: v.deny } } }])));
    case 'first-applicable':
      return {
        priority: voters.flatMap((v) => [...(v.deny === undefined ? [] : [{ when: { computed: v.deny } as Rewrite, then: 'deny' as const }]), ...(v.permit === undefined ? [] : [{ when: { computed: v.permit } as Rewrite, then: 'permit' as const }])]),
      };
  }
}
