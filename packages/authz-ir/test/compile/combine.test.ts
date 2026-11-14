import 'mocha';
import { expect } from 'chai';
import * as fc from 'fast-check';
import { BUILTIN_COMBINATORS, CONDITION_UNKNOWN, FALSE, TRUE, evaluateResidual } from '@spinajs/authz';
import type { EvaluationContext, ResourceFilter, SubjectEnv, Vote } from '@spinajs/authz';

import { IREvaluator, MemoryTupleSource, combineVotes, mergeFragments, principalNarrowing, routeFor } from '../../src/index.js';
import type { CombineEntryIR, IRFragment, ModelVote, PolicyIR, Rewrite, Truth } from '../../src/index.js';

type Side = Truth | 'absent';
const side = fc.constantFrom<Side>('allow', 'deny', 'unknown', 'absent');
const ALGORITHMS = ['deny-overrides', 'permit-overrides', 'first-applicable'] as const;

const filterOf = (s: Side): ResourceFilter => (s === 'allow' ? TRUE : s === 'unknown' ? CONDITION_UNKNOWN : FALSE);
const rewriteOf = (s: Truth): Rewrite => (s === 'allow' ? { intersection: [] } : s === 'unknown' ? { opaque: 'u' } : { priority: [] });

async function engine(algorithm: string, votes: ReadonlyArray<[Side, Side]>): Promise<Truth> {
  const combinator = BUILTIN_COMBINATORS.find((c) => c.name === algorithm)!;
  const { allow } = combinator.combine(votes.map(([p, d], i): Vote => ({ model: `m${i}`, permitWhen: filterOf(p), denyWhen: filterOf(d), cacheable: true })));
  const env = { principal: { type: 'user', id: 'u', authenticated: true, source: 't', attributes: {} }, ref: { type: 't', id: 'x' }, attribute: () => undefined, relation: () => undefined, ancestors: () => Promise.resolve(null), native: () => undefined, ctx: {} as EvaluationContext } as SubjectEnv;
  const t = await evaluateResidual(allow, {}, env);
  return t === undefined ? 'unknown' : t ? 'allow' : 'deny';
}

async function ir(algorithm: CombineEntryIR['algorithm'], votes: ReadonlyArray<[Side, Side]>): Promise<Truth> {
  const permissions: Record<string, Rewrite> = {};
  const modelVotes: ModelVote[] = votes.map(([p, d], i) => {
    const v: ModelVote = { model: `m${i}` };
    if (p !== 'absent') permissions[(v.permit = `p${i}`)] = rewriteOf(p);
    if (d !== 'absent') permissions[(v.deny = `d${i}`)] = rewriteOf(d);
    return v;
  });
  permissions.combined = combineVotes({ algorithm }, modelVotes);
  const policy: PolicyIR = { version: 1, types: { t: { relations: {}, permissions } }, permissions: { 't:do': { type: 't', relation: 'combined', list: false, source: { origin: 'test' } } }, caveats: {}, combine: { default: { algorithm } }, principal: { ...principalNarrowing(), roles: {} }, opaque: [] };
  return (await new IREvaluator(policy, new MemoryTupleSource()).check({ principal: { type: 'user', id: 'u' }, permission: 't:do', resource: { type: 't', id: 'x' } })).truth;
}

describe('combine (G5)', () => {
  for (const algorithm of ALGORITHMS) {
    it(`${algorithm} agrees with the engine combinator on random three-valued votes`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.tuple(side, side), { minLength: 1, maxLength: 4 }), async (votes) => {
          expect(await ir(algorithm, votes)).to.equal(await engine(algorithm, votes));
        }),
        { numRuns: 300 },
      );
    });
  }

  it('routes a type to its own entry, keeps its models order and drops the others', () => {
    const combine = { default: { algorithm: 'deny-overrides' as const }, types: { doc: { algorithm: 'first-applicable' as const, models: ['b', 'a'] } } };
    expect(routeFor(combine, 'file')).to.equal(combine.default);
    expect(combineVotes(routeFor(combine, 'doc'), [{ model: 'a', permit: 'pa' }, { model: 'b', deny: 'db' }, { model: 'c', permit: 'pc' }])).to.deep.equal({
      priority: [
        { when: { computed: 'db' }, then: 'deny' },
        { when: { computed: 'pa' }, then: 'permit' },
      ],
    });
    expect(combineVotes({ algorithm: { opaque: 'custom' } }, [{ model: 'a', permit: 'pa' }])).to.deep.equal({ opaque: 'combinator custom' });
  });

  it('merge binds through the route of the permission type', () => {
    const a: IRFragment = { model: 'a', types: { doc: { relations: {}, permissions: { pa: { intersection: [] } } } }, permissions: { 'doc:read': { type: 'doc', permit: 'pa', source: { origin: 't' } } } };
    const b: IRFragment = { model: 'b', types: { doc: { relations: {}, permissions: { pb: { intersection: [] }, db: { priority: [] } } } }, permissions: { 'doc:read': { type: 'doc', permit: 'pb', deny: 'db', source: { origin: 't' } } } };
    const { ir: merged } = mergeFragments([a, b], { combine: { default: { algorithm: 'permit-overrides' } } });
    expect(merged.types.doc.permissions.perm_doc_read).to.deep.equal({ union: [{ computed: 'pa' }, { exclusion: { base: { computed: 'pb' }, subtract: { computed: 'db' } } }] });
  });
});
