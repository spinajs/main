import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { Authorizer } from '../../../src/engine/authorizer.js';
import { defaultAttribute, evaluateResidual } from '../../../src/engine/evaluate.js';
import type { SubjectEnv } from '../../../src/engine/evaluate.js';
import { FALSE, TRUE } from '../../../src/index.js';
import type { EvaluationContext, ResourceFilter, ResourceRef, Value } from '../../../src/index.js';
import { FakeAdapter, FakeRelation, FakeRow, StaticModel, permit, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const alice = principal('user', 'alice', { attributes: { team: 't1' } });
const FOLDERS = [new FakeRow('folder', 'f1'), new FakeRow('folder', 'f2', {}, { type: 'folder', id: 'f1' })];

const editor = () => new FakeRelation('doc', 'editor', (p, _ref, subject) => Array.isArray((subject as FakeRow | undefined)?.editors) && ((subject as FakeRow).editors as string[]).includes(p.id));

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
    const leaf = fc.oneof(
      cmpNode,
      cmpNode,
      fc.constant<ResourceFilter>({ op: 'relation', relation: 'editor' }),
      fc.constant<ResourceFilter>({ op: 'relation', relation: 'unknown' }),
      scopes.map((s) => ({ op: 'under', scopes: s } as ResourceFilter)),
      fc.constantFrom(TRUE, FALSE),
    );
    const { tree } = fc.letrec<{ tree: ResourceFilter }>((self) => ({
      tree: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        leaf,
        fc.array(self('tree'), { minLength: 1, maxLength: 3 }).map((args) => ({ op: 'and', args } as ResourceFilter)),
        fc.array(self('tree'), { minLength: 1, maxLength: 3 }).map((args) => ({ op: 'or', args } as ResourceFilter)),
        self('tree').map((arg) => ({ op: 'not', arg } as ResourceFilter)),
      ),
    }));
    const attr = fc.constantFrom<unknown>('alice', 'bob', 't1', 1, 2, '2', null, undefined);
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
});
