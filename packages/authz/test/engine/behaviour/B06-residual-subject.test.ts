import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { Authorizer } from '../../../src/engine/authorizer.js';
import { defaultAttribute, evaluateResidual } from '../../../src/engine/evaluate.js';
import type { SubjectEnv } from '../../../src/engine/evaluate.js';
import { CORE_FILTER_OPS, FALSE, TRUE } from '../../../src/index.js';
import type { DecisionRequest, EvaluationContext, Principal, ResourceFilter, ResourceRef, Value, Vote } from '../../../src/index.js';
import { FakeAdapter, FakeNativeFilter, FakeRelation, FakeRow, StaticModel, permit, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const alice = principal('user', 'alice', { attributes: { team: 't1' } });
const FOLDERS = [new FakeRow('folder', 'f1'), new FakeRow('folder', 'f2', {}, { type: 'folder', id: 'f1' })];

const editor = () => new FakeRelation('doc', 'editor', (p, _ref, subject) => Array.isArray((subject as FakeRow | undefined)?.editors) && ((subject as FakeRow).editors as string[]).includes(p.id));
const fav = () => new FakeNativeFilter('native:fav', (args, subject) => Array.isArray((subject as FakeRow | undefined)?.favs) && ((subject as FakeRow).favs as string[]).includes((args as { who: string }).who));
class PinFilter extends FakeNativeFilter {
  readonly principalInArgs = true;
}
const pin = () => new PinFilter('native:pin', (args, subject) => Array.isArray((subject as FakeRow | undefined)?.pins) && ((subject as FakeRow).pins as string[]).includes((args as { who: string }).who));

const values = fc.constantFrom<Value>('alice', 'bob', 't1', 1, 2, '2', true, null, ['alice', 't1'], [1, 2], { ref: 'principal.id' }, { ref: 'principal.attributes.team' }, { ref: 'principal.attributes.missing' }, { ref: 'env.now' });
const cmpNode = fc.record({ field: fc.constantFrom('owner', 'level', 'team', 'missing'), cmp: fc.constantFrom('eq', 'ne', 'in', 'nin', 'lt', 'gte', 'null', 'notnull'), value: values }).map((c) => ({ op: 'cmp', ...c } as ResourceFilter));
const scopes = fc.constantFrom<ResourceRef[]>(
  [{ type: 'folder', id: 'f1' }],
  [{ type: 'folder', id: 'f2' }],
  [{ type: 'folder' }],
  [
    { type: 'doc', id: 'd0' },
    { type: 'folder', id: 'f2' },
  ],
);
const treeOf = (leaf: fc.Arbitrary<ResourceFilter>): fc.Arbitrary<ResourceFilter> =>
  fc.letrec<{ tree: ResourceFilter }>((self) => ({
    tree: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc.array(self('tree'), { minLength: 1, maxLength: 3 }).map((args) => ({ op: 'and', args } as ResourceFilter)),
      fc.array(self('tree'), { minLength: 1, maxLength: 3 }).map((args) => ({ op: 'or', args } as ResourceFilter)),
      self('tree').map((arg) => ({ op: 'not', arg } as ResourceFilter)),
    ),
  })).tree;
const attr = fc.constantFrom<unknown>('alice', 'bob', 't1', 1, 2, '2', null, undefined);

describe('B06: residual and subject', () => {
  it('B06: without a subject a conditional permit is allowed with a non-TRUE residual; with a subject the answer is definite', async () => {
    const mine = new FakeRow('doc', 'd1', { owner: 'alice' });
    const theirs = new FakeRow('doc', 'd2', { owner: 'bob' });
    const adapter = new FakeAdapter(['doc', 'folder'], { rows: [mine, theirs] });
    const a = new Authorizer({ domain: 'root', registry, adapters: [adapter], models: [new StaticModel('m', { vote: permit({ op: 'cmp', field: 'owner', cmp: 'eq', value: { ref: 'principal.id' } }) })] });

    const open = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    expect(open.allowed).to.equal(true);
    expect(open.residual).to.not.equal(TRUE);
    expect(open.residual).to.deep.equal({ op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' });

    const yes = await a.check({ principal: alice, permission: 'doc:read', resource: mine });
    expect(yes.allowed).to.equal(true);
    expect(yes.residual).to.equal(TRUE);
    const no = await a.check({ principal: alice, permission: 'doc:read', resource: theirs });
    expect(no.allowed).to.equal(false);
    expect(no.residual).to.equal(FALSE);
  });

  it('B06: check({ subject: row }).allowed ⇔ evaluateResidual(filter(...), row) === true', async function () {
    this.timeout(60000);
    const leaf = fc.oneof(
      cmpNode,
      cmpNode,
      fc.constant<ResourceFilter>({ op: 'relation', relation: 'editor' }),
      fc.constant<ResourceFilter>({ op: 'relation', relation: 'unknown' }),
      scopes.map((s) => ({ op: 'under', scopes: s } as ResourceFilter)),
      fc.constantFrom(TRUE, FALSE),
    );
    const tree = treeOf(leaf);
    const rowArb = fc.record({ owner: attr, level: attr, team: attr, editors: fc.constantFrom(undefined, ['alice'], ['bob']), parent: fc.constantFrom<ResourceRef | undefined>(undefined, { type: 'folder', id: 'f1' }, { type: 'folder', id: 'f2' }) });
    const voteArb = fc.record({ permitWhen: fc.oneof(tree, fc.constant(FALSE)), denyWhen: fc.oneof(tree, fc.constant(FALSE)) });

    await fc.assert(
      fc.asyncProperty(fc.constantFrom('deny-overrides', 'permit-overrides', 'first-applicable'), fc.array(voteArb, { minLength: 1, maxLength: 3 }), fc.array(rowArb, { minLength: 1, maxLength: 4 }), async (algorithm, votes, rowSpecs) => {
        const rows = rowSpecs.map((r, i) => {
          const attrs: Record<string, unknown> = {};
          for (const k of ['owner', 'level', 'team', 'editors'] as const) if (r[k] !== undefined) attrs[k] = r[k];
          return new FakeRow('doc', `d${i}`, attrs, r.parent);
        });
        const relation = editor();
        const adapter = new FakeAdapter(['doc', 'folder'], { rows: [...FOLDERS, ...rows] });
        const models = votes.map((v, i) => new StaticModel(`m${i}`, { vote: v }));
        const a = new Authorizer({ domain: 'root', registry, adapters: [adapter], relations: [relation], models, combine: { default: { algorithm } }, clock: () => new Date('2026-10-01T00:00:00Z') });

        const residual = await a.filter(alice, 'doc:read', 'doc');
        expect(JSON.stringify(residual)).to.not.include('"ref"');
        for (const row of rows) {
          const ref = { type: 'doc', id: row.id };
          const env: SubjectEnv = { principal: alice, ref, attribute: defaultAttribute, relation: (t, n) => (t === 'doc' && n === 'editor' ? relation : undefined), ancestors: (r) => adapter.ancestors(r), native: () => undefined, ctx: {} as EvaluationContext };
          const expected = (await evaluateResidual(residual, row, env)) === true;
          const d = await a.check({ principal: alice, permission: 'doc:read', resource: row });
          expect(d.allowed, JSON.stringify({ residual, row })).to.equal(expected);
          expect(d.residual).to.equal(expected ? TRUE : FALSE);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('B06 under delegation: check ⇔ filter for a user, intersect agents (one and two hops) and an inherit agent, relation and native leaves included, principalInArgs ones kept', async function () {
    this.timeout(120000);
    const WHO = 'self';
    const leaf = fc.oneof(
      cmpNode,
      cmpNode,
      fc.constant<ResourceFilter>({ op: 'relation', relation: 'editor' }),
      fc.constant<ResourceFilter>({ op: 'native:fav', args: WHO }),
      fc.constant<ResourceFilter>({ op: 'native:pin', args: WHO }),
      scopes.map((s) => ({ op: 'under', scopes: s } as ResourceFilter)),
      fc.constantFrom(TRUE, FALSE),
    );
    const tree = treeOf(leaf);
    // Native args are opaque: a model names the principal in them, as native:rbac.assignment does.
    const forPrincipal = (f: ResourceFilter, id: string): ResourceFilter => {
      if (f.op === 'and' || f.op === 'or') return { op: f.op, args: f.args.map((x) => forPrincipal(x, id)) };
      if (f.op === 'not') return { op: 'not', arg: forPrincipal(f.arg, id) };
      return f.op === 'native:fav' || f.op === 'native:pin' ? { op: f.op, args: { who: id } } : f;
    };
    const ids = ['alice', 'bob', 't1', 't2', 't3'] as const;
    const voteArb = fc.record({ permitWhen: fc.oneof(tree, fc.constant(FALSE)), denyWhen: fc.oneof(tree, fc.constant(FALSE)) });
    const modelVotes = fc.record(Object.fromEntries(ids.map((id) => [id, voteArb])) as Record<(typeof ids)[number], typeof voteArb>);
    const people = fc.constantFrom<unknown>(undefined, ['alice'], ['bob'], ['t1', 't3'], ['bob', 't2', 'alice']);
    const rowArb = fc.record({ owner: attr, level: attr, team: attr, editors: people, favs: people, pins: people, parent: fc.constantFrom<ResourceRef | undefined>(undefined, { type: 'folder', id: 'f1' }, { type: 'folder', id: 'f2' }) });

    const bob = principal('user', 'bob');
    const principals: readonly Principal[] = [alice, principal('token', 't1', { onBehalfOf: bob }), principal('agent', 'a1', { onBehalfOf: bob, delegation: 'inherit' }), principal('token', 't2', { onBehalfOf: principal('token', 't3', { onBehalfOf: alice }) })];
    const holdsPrincipalOps = (f: ResourceFilter): boolean => {
      if (f.op === 'relation' || f.op.startsWith('native:')) return true;
      if (f.op === 'and' || f.op === 'or') return f.args.some(holdsPrincipalOps);
      return f.op === 'not' && holdsPrincipalOps(f.arg);
    };
    // A native:pin leaf naming another principal than the one asking came from a delegate's residual.
    const pinOfOther = (f: ResourceFilter, self: string): boolean => {
      if (f.op === 'native:pin') return (f.args as { who: string }).who !== self;
      if (f.op === 'and' || f.op === 'or') return f.args.some((x) => pinOfOther(x, self));
      return f.op === 'not' && pinOfOther(f.arg, self);
    };
    let stripped = 0;
    let kept = 0;

    await fc.assert(
      fc.asyncProperty(fc.constantFrom('deny-overrides', 'permit-overrides', 'first-applicable'), fc.array(modelVotes, { minLength: 1, maxLength: 2 }), fc.array(rowArb, { minLength: 1, maxLength: 4 }), async (algorithm, votes, rowSpecs) => {
        const rows = rowSpecs.map((r, i) => {
          const attrs: Record<string, unknown> = {};
          for (const k of ['owner', 'level', 'team', 'editors', 'favs', 'pins'] as const) if (r[k] !== undefined) attrs[k] = r[k];
          return new FakeRow('doc', `d${i}`, attrs, r.parent);
        });
        const relation = editor();
        const native = fav();
        const pinned = pin();
        const adapter = new FakeAdapter(['doc', 'folder'], { rows: [...FOLDERS, ...rows] });
        const models = votes.map(
          (byId, i) =>
            new StaticModel(`m${i}`, {
              capabilities: { residuals: [...CORE_FILTER_OPS, 'native:fav', 'native:pin'] },
              vote: (req: DecisionRequest): Vote => {
                const v = byId[req.principal.id as (typeof ids)[number]];
                return { model: `m${i}`, permitWhen: forPrincipal(v.permitWhen, req.principal.id), denyWhen: forPrincipal(v.denyWhen, req.principal.id), cacheable: true };
              },
            }),
        );
        const a = new Authorizer({ domain: 'root', registry, adapters: [adapter], relations: [relation], nativeFilters: [native, pinned], models, combine: { default: { algorithm } }, clock: () => new Date('2026-10-01T00:00:00Z') });

        for (const p of principals) {
          const typed = await a.check({ principal: p, permission: 'doc:read', resource: { type: 'doc' } });
          const residual = typed.residual;
          expect(await a.filter(p, 'doc:read', 'doc')).to.deep.equal(residual);
          expect(JSON.stringify(residual)).to.not.include('"ref"');
          const delegate = p.delegation === 'inherit' ? undefined : p.onBehalfOf;
          const strips = delegate !== undefined && holdsPrincipalOps(await a.filter(delegate, 'doc:read', 'doc'));
          const keeps = delegate !== undefined && pinOfOther(residual, typed.principal.id);
          const runAs = principal(typed.principal.type, typed.principal.id);
          for (const row of rows) {
            const ref = { type: 'doc', id: row.id };
            const env: SubjectEnv = { principal: runAs, ref, attribute: defaultAttribute, relation: (t, n) => (t === 'doc' && n === 'editor' ? relation : undefined), ancestors: (r) => adapter.ancestors(r), native: (op) => (op === 'native:fav' ? native : op === 'native:pin' ? pinned : undefined), ctx: {} as EvaluationContext };
            const expected = (await evaluateResidual(residual, row, env)) === true;
            const d = await a.check({ principal: p, permission: 'doc:read', resource: row });
            expect(d.allowed, JSON.stringify({ principal: p.id, residual, row })).to.equal(expected);
            expect(d.residual).to.equal(expected ? TRUE : FALSE);
            if (strips) stripped++;
            if (keeps) kept++;
          }
        }
      }),
      { numRuns: 150 },
    );
    // Row checks of intersect agents whose delegate's residual held a relation or native op, stripped in the filter.
    expect(stripped).to.be.greaterThan(0);
    // Row checks of intersect agents whose filter kept the delegate's native:pin leaf.
    expect(kept).to.be.greaterThan(0);
  });
});
