import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { Authorizer } from '../../../src/engine/authorizer.js';
import { defaultAttribute, evaluateResidual } from '../../../src/engine/evaluate.js';
import type { SubjectEnv } from '../../../src/engine/evaluate.js';
import { FALSE, TRUE } from '../../../src/index.js';
import type { Decision, EvaluationContext, ResourceFilter } from '../../../src/index.js';
import { StaticModel, deny, permit, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const alice = principal('user', 'alice');

const check = (algorithm: string, models: StaticModel[]): Promise<Decision> => new Authorizer({ domain: 'root', models, registry, combine: { default: { algorithm } } }).check({ principal: alice, permission: 'doc:read' });

describe('B03: combination', () => {
  it('B03: deny-overrides — any deny wins over any permit', async () => {
    expect((await check('deny-overrides', [new StaticModel('p', { vote: permit() }), new StaticModel('d', { vote: deny() })])).allowed).to.equal(false);
    expect((await check('deny-overrides', [new StaticModel('d', { vote: deny() }), new StaticModel('p', { vote: permit() })])).allowed).to.equal(false);
    expect((await check('deny-overrides', [new StaticModel('p', { vote: permit() }), new StaticModel('n')])).allowed).to.equal(true);
  });

  it('B03: permit-overrides — a permit not denied by its own model wins', async () => {
    expect((await check('permit-overrides', [new StaticModel('p', { vote: permit() }), new StaticModel('d', { vote: deny() })])).allowed).to.equal(true);
    expect((await check('permit-overrides', [new StaticModel('d', { vote: deny() }), new StaticModel('p', { vote: permit() })])).allowed).to.equal(true);
    expect((await check('permit-overrides', [new StaticModel('pd', { vote: { permitWhen: TRUE, denyWhen: TRUE } }), new StaticModel('n')])).allowed).to.equal(false);
  });

  it('B03: first-applicable — the first model that permits or denies decides', async () => {
    expect((await check('first-applicable', [new StaticModel('n'), new StaticModel('d', { vote: deny() }), new StaticModel('p', { vote: permit() })])).allowed).to.equal(false);
    expect((await check('first-applicable', [new StaticModel('n'), new StaticModel('p', { vote: permit() }), new StaticModel('d', { vote: deny() })])).allowed).to.equal(true);
  });

  it('B03: evaluation order and model delays never change the answer', async function () {
    this.timeout(60000);
    const atom = (field: string): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value: 1 });
    const filters = fc.constantFrom<ResourceFilter>(TRUE, FALSE, atom('a'), atom('b'));
    const voteArb = fc.record({ permitWhen: filters, denyWhen: filters, delay: fc.integer({ min: 0, max: 3 }), async: fc.boolean() });
    // Plan order may change the residual's syntax (argument order), never its truth on any row.
    const rows = [1, 0, null].flatMap((a) => [1, 0, null].map((b) => ({ a, b })));
    const env: SubjectEnv = { principal: alice, ref: { type: 'doc', id: 'x' }, attribute: defaultAttribute, relation: () => undefined, ancestors: async () => null, native: () => undefined, ctx: {} as EvaluationContext };
    const truths = (f: ResourceFilter) => Promise.all(rows.map((row) => evaluateResidual(f, row, env)));
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('deny-overrides', 'permit-overrides'), fc.array(voteArb, { minLength: 1, maxLength: 4 }), async (algorithm, specs) => {
        const build = (order: readonly number[], delayed: boolean) =>
          order.map((i) => {
            const s = specs[i];
            const vote = { permitWhen: s.permitWhen, denyWhen: s.denyWhen };
            return new StaticModel(`m${i}`, delayed && s.async ? { vote, delayMs: s.delay } : { vote });
          });
        const forward = specs.map((_, i) => i);
        const orders = [forward, [...forward].reverse(), [...forward.slice(1), forward[0]]];
        const sync = await check(algorithm, build(forward, false));
        const delayed = await check(algorithm, build(forward, true));
        expect(delayed.allowed).to.equal(sync.allowed);
        expect(delayed.residual).to.deep.equal(sync.residual);
        expect(delayed.reason).to.deep.equal(sync.reason);
        const expected = await truths(sync.residual);
        for (const order of orders) {
          const d = await check(algorithm, build(order, true));
          expect(d.allowed).to.equal(sync.allowed);
          expect(d.reason).to.deep.equal(sync.reason);
          expect(await truths(d.residual)).to.deep.equal(expected);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('B03: first-applicable — random delays never change the answer for one order', async function () {
    this.timeout(60000);
    const filters = fc.constantFrom<ResourceFilter>(TRUE, FALSE, { op: 'cmp', field: 'a', cmp: 'eq', value: 1 });
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ permitWhen: filters, denyWhen: filters }), { minLength: 1, maxLength: 4 }), fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 4, maxLength: 4 }), async (specs, delays) => {
        const sync = await check(
          'first-applicable',
          specs.map((s, i) => new StaticModel(`m${i}`, { vote: s })),
        );
        const slow = await check(
          'first-applicable',
          specs.map((s, i) => new StaticModel(`m${i}`, { vote: s, delayMs: delays[i] })),
        );
        expect(slow.allowed).to.equal(sync.allowed);
        expect(slow.residual).to.deep.equal(sync.residual);
        expect(slow.reason).to.deep.equal(sync.reason);
      }),
      { numRuns: 50 },
    );
  });
});
