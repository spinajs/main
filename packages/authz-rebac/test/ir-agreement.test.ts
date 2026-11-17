import 'mocha';
import * as fc from 'fast-check';
import { DefaultConditionCompiler } from '@spinajs/authz';
import { mergeFragments } from '@spinajs/authz-ir';
import type { EvalInput } from '@spinajs/authz-ir';
import { fakeEvaluationContext, fakeModelInitContext, irAgreement, userPrincipal, voteTruth } from '@spinajs/authz-testing';

import { MemoryTupleStore, NamespaceSchema, RebacModel, rebacTupleSource, rebacToIR } from '../src/index.js';
import type { CaveatConfig, NamespaceConfig, Rewrite, Tuple, TupleCaveat } from '../src/index.js';

const TYPES = ['a', 'b'] as const;
const IDS = ['1', '2'];
const USERS = ['u1', 'u2', 'u3'];
const RELATIONS: Readonly<Record<(typeof TYPES)[number], Readonly<Record<string, readonly string[]>>>> = {
  a: { r0: ['user', 'a#r0', 'b#p0', 'user with c_ip', 'a#r0 with c_lvl'], r1: ['user', 'user with c_lvl'], parent: ['a', 'b', 'b with c_ip'] },
  b: { r0: ['user', 'a#p1', 'a#p1 with c_ip'], r1: ['user'], parent: ['a', 'a with c_lvl'] },
};
const CAVEATS: CaveatConfig = {
  c_ip: { params: { 'env.ip': 'string' }, expr: { attr: 'env.ip', eq: 'a' } },
  c_lvl: { params: { 'env.lvl': 'int', 'env.min': 'int' }, expr: { attr: 'env.lvl', gte: { ref: 'env.min' } } },
};
/** Each env decides some caveats and leaves others unknown. */
const ENVS = [{}, { ip: 'a' }, { ip: 'b' }, { lvl: 1 }, { lvl: 3, ip: 'a' }];
const PERMISSIONS = Object.fromEntries(TYPES.flatMap((t) => ['p0', 'p1'].map((p) => [`${t}:${p}`, `${t}#${p}`])));
const INPUTS = TYPES.flatMap((t) => ['p0', 'p1'].map((p) => ({ name: `${t}:${p}`, types: [t] })));

/** A rewrite of permission `p<index>`: relations, earlier permissions and parent arrows, combined at most three deep. */
function rewrite(index: number): fc.Arbitrary<Rewrite> {
  const names = ['r0', 'r1', ...Array.from({ length: index }, (_, i) => `p${i}`)];
  const leaf = fc.oneof(fc.constantFrom(...names), fc.constantFrom('r0', 'r1', 'p0', 'p1').map((n) => `parent->${n}`));
  const tree = fc.letrec<{ node: Rewrite }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc.tuple(tie('node'), tie('node')).map(([x, y]) => ({ union: [x, y] })),
      fc.tuple(tie('node'), tie('node')).map(([x, y]) => ({ intersection: [x, y] })),
      fc.tuple(tie('node'), tie('node')).map(([base, subtract]) => ({ exclusion: { base, subtract } })),
    ),
  }));
  return tree.node;
}

const namespaces: fc.Arbitrary<NamespaceConfig> = fc.tuple(rewrite(0), rewrite(1), rewrite(0), rewrite(1)).map(([a0, a1, b0, b1]) => ({
  user: {},
  a: { relations: RELATIONS.a, permissions: { p0: a0, p1: a1 } },
  b: { relations: RELATIONS.b, permissions: { p0: b0, p1: b1 } },
}));

const ref = (type: string, id: string) => ({ type, id });
const caveat: fc.Arbitrary<TupleCaveat | undefined> = fc.option(fc.oneof(fc.constant({ name: 'c_ip' }), fc.integer({ min: 0, max: 3 }).map((min) => ({ name: 'c_lvl', context: { 'env.min': min } }))), { nil: undefined });
// The store keeps only what schema.problem() admits, so most caveats land only where a relation takes them.
const tuple: fc.Arbitrary<Tuple> = fc
  .tuple(fc.constantFrom(...TYPES), fc.constantFrom(...IDS), fc.constantFrom('r0', 'r1', 'parent'), fc.constantFrom(...USERS), fc.constantFrom(...TYPES), fc.constantFrom(...IDS), fc.constantFrom('r0', 'p0', 'p1', ''), caveat)
  .map(([type, id, relation, user, otherType, otherId, set, c]) => ({
    ...(c ? { caveat: c } : {}),
    object: ref(type, id),
    relation,
    subject: relation === 'parent' ? ref(otherType, otherId) : set === '' ? { type: 'user', id: user } : { object: ref(otherType, otherId), relation: set },
  }));

const LIMIT = { maxDepth: 3, maxCalls: 1000 };

describe('authz-rebac: IR agreement (Z6)', function () {
  this.timeout(600000);

  it('RebacModel and IREvaluator agree on random namespaces, tuples and requests', async () => {
    await irAgreement(fc.record({ namespaces, tuples: fc.array(tuple, { maxLength: 12 }) }), async ({ namespaces: ns, tuples }) => {
      const schema = NamespaceSchema.compile(ns, PERMISSIONS, CAVEATS);
      const store = new MemoryTupleStore(tuples.filter((t) => schema.problem(t) === undefined));
      const model = new RebacModel({ store, namespaces: ns, permissions: PERMISSIONS, caveats: CAVEATS, limit: LIMIT });
      await model.init(fakeModelInitContext({ permissions: INPUTS, model: model.name }));
      const requests: EvalInput[] = TYPES.flatMap((t) => IDS.flatMap((id) => ['p0', 'p1'].flatMap((p) => USERS.flatMap((u) => ENVS.map((env) => ({ principal: { type: 'user', id: u }, permission: `${t}:${p}`, resource: ref(t, id), context: { env } }))))));
      return {
        ir: mergeFragments([rebacToIR(schema)]).ir,
        tuples: rebacTupleSource(store),
        requests,
        engine: async (r) => voteTruth(await model.evaluate({ principal: userPrincipal(r.principal.id), permission: r.permission, resource: r.resource, env: r.context?.env ?? {} }, fakeEvaluationContext({ permissions: INPUTS, conditions: new DefaultConditionCompiler() }))),
      };
    }, LIMIT);
  });
});
