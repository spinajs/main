import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';
import { fakeEvaluationContext } from '@spinajs/authz-testing';

import { defaultAttribute, evaluateResidual } from '../../src/engine/evaluate.js';
import type { SubjectEnv } from '../../src/engine/evaluate.js';
import { BUILTIN_CONDITION_FUNCTIONS, CONDITION_UNKNOWN, DefaultConditionCompiler, FALSE, SCOPE_CONDITION_FILTER, SCOPE_CONDITION_OP, ScopeConditionFilter, and, not, or, parseScopeConditionArgs } from '../../src/index.js';
import type { Condition, DecisionRequest, EvaluationContext, Principal, ResourceFilter, ResourceRef } from '../../src/index.js';
import { FakeScopeResolver, principal } from '../engine/fakes.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice: Principal = principal('user', 'alice', { attributes: { pool: 'gold', n: 2, teams: ['gold', 'red'], obj: { a: 1 } } });
const agent: Principal = principal('agent', 'ag1', { attributes: { team: 'red' } });

const O1 = { type: 'org', id: 'o1' };
const P1 = { type: 'project', id: 'p1' };
const ref = (id: string): ResourceRef => ({ type: 'file', id });

const resolver = (): FakeScopeResolver =>
  new FakeScopeResolver(
    ['org', 'project', 'file'],
    {
      'org:o1': null,
      'org:o2': null,
      'org:o3': null,
      'project:p1': O1,
      'file:f1': P1,
      'file:f2': null,
      'file:f3': { type: 'org', id: 'o2' },
      'file:f4': { type: 'org', id: 'o3' },
      'file:f5': { type: 'org' },
    },
    {
      'org:o1': { policies: { level: 'gold', open: true, nil: null, obj: { a: 1 }, list: ['a', 1], n: 5, s: 'abc', num: '5' } },
      'org:o2': {},
      'org:o3': null,
    },
  );

const ctxFor = (over: Partial<EvaluationContext> = {}): EvaluationContext => ({ ...fakeEvaluationContext({ now: NOW, scopeResolvers: [resolver()] as never, permissions: [{ name: 'file:read', types: ['file', 'project', 'org'] }] }), ...over });

const args = (test: 'true' | 'false', path: string, op: string, value: unknown) => ({ v: 1, test, type: 'org', path, op, value });
const faultArgs = (path: string, type = 'org') => ({ v: 1, test: 'fault', type, path });

/** [true, false, fault] of the three tests of one comparison on one row. */
async function tests(path: string, op: string, value: unknown, row: ResourceRef, ctx = ctxFor()): Promise<[boolean, boolean, boolean]> {
  const m = (a: unknown) => SCOPE_CONDITION_FILTER.matches(a, undefined, row, ctx);
  return [await m(args('true', path, op, value)), await m(args('false', path, op, value)), await m(faultArgs(path))];
}

describe('conditions: scope condition leaves', () => {
  describe('ScopeConditionFilter', () => {
    it('is one frozen singleton for its op that reads no principal', () => {
      expect(SCOPE_CONDITION_OP).to.equal('native:condition.scope');
      expect(SCOPE_CONDITION_FILTER).to.be.instanceOf(ScopeConditionFilter);
      expect(SCOPE_CONDITION_FILTER.op).to.equal(SCOPE_CONDITION_OP);
      expect(SCOPE_CONDITION_FILTER.principalInArgs).to.equal(true);
      expect(Object.isFrozen(SCOPE_CONDITION_FILTER)).to.equal(true);
    });

    it('true / false follow the comparison on the nearest node holding the value', async () => {
      expect(await tests('policies.open', 'eq', true, ref('f1'))).to.deep.equal([true, false, false]);
      expect(await tests('policies.level', 'eq', 'silver', ref('f1'))).to.deep.equal([false, true, false]);
      expect(await tests('policies.level', 'ne', 'silver', ref('f1'))).to.deep.equal([true, false, false]);
      expect(await tests('policies.n', 'gt', 4, ref('f1'))).to.deep.equal([true, false, false]);
      expect(await tests('policies.num', 'eq', 5, ref('f1'))).to.deep.equal([true, false, false]);
      expect(await tests('policies.s', 'like', 'a%', ref('f1'))).to.deep.equal([true, false, false]);
      expect(await tests('policies.s', 'glob', 'x*', ref('f1'))).to.deep.equal([false, true, false]);
      // The project node has no org attributes: the nearest org (o1) above it decides.
      expect(await tests('policies.open', 'eq', true, P1)).to.deep.equal([true, false, false]);
    });

    it('a null, missing or unknown read faults; true and false are both FALSE there', async () => {
      expect(await tests('policies.nil', 'eq', 'x', ref('f1'))).to.deep.equal([false, false, true]);
      expect(await tests('policies.gone', 'eq', 'x', ref('f1'))).to.deep.equal([false, false, true]);
      expect(await tests('policies.open', 'eq', true, ref('f3'))).to.deep.equal([false, false, true]); // attribute missing on o2
      expect(await tests('policies.open', 'eq', true, ref('f4'))).to.deep.equal([false, false, true]); // o3 is an unknown node
      expect(await tests('policies.open', 'eq', true, ref('f2'))).to.deep.equal([false, false, true]); // no org ancestor
      expect(await tests('policies.open', 'eq', true, ref('f5'))).to.deep.equal([false, false, true]); // org ancestor without id
      expect(await tests('policies.open', 'eq', true, ref('nope'))).to.deep.equal([false, false, true]); // unknown resource
      expect(await tests('policies.open.deeper', 'eq', true, ref('f1'))).to.deep.equal([false, false, true]);
    });

    it('an engine UNKNOWN comparison is neither true nor false, and no fault', async () => {
      expect(await tests('policies.s', 'lt', 5, ref('f1'))).to.deep.equal([false, false, false]);
      expect(await tests('policies.obj', 'eq', 1, ref('f1'))).to.deep.equal([false, false, false]);
      expect(await tests('policies.list', 'eq', 'a', ref('f1'))).to.deep.equal([false, false, false]);
      expect(await tests('policies.open', 'lt', 1, ref('f1'))).to.deep.equal([false, false, false]);
      expect(await tests('policies.level', 'in', [1, 2], ref('f1'))).to.deep.equal([false, false, false]);
      expect(await tests('policies.level', 'like', 'a\\', ref('f1'))).to.deep.equal([false, false, false]);
    });

    it('null: true | false tests a present value', async () => {
      expect(await tests('policies.level', 'null', true, ref('f1'))).to.deep.equal([false, true, false]);
      expect(await tests('policies.level', 'null', false, ref('f1'))).to.deep.equal([true, false, false]);
      expect(await tests('policies.nil', 'null', true, ref('f1'))).to.deep.equal([false, false, true]);
    });

    it('in / nin over a list', async () => {
      expect(await tests('policies.level', 'in', ['silver', 'gold'], ref('f1'))).to.deep.equal([true, false, false]);
      expect(await tests('policies.level', 'nin', ['silver', 'gold'], ref('f1'))).to.deep.equal([false, true, false]);
      expect(await tests('policies.n', 'in', ['5'], ref('f1'))).to.deep.equal([true, false, false]);
      expect(await tests('policies.level', 'nin', [], ref('f1'))).to.deep.equal([true, false, false]);
    });

    it('a ref without id faults and is neither true nor false', async () => {
      expect(await tests('policies.open', 'eq', true, { type: 'file' })).to.deep.equal([false, false, true]);
      expect(await tests('policies.open', 'eq', true, { type: 'file', id: null } as never)).to.deep.equal([false, false, true]);
    });

    it('a rejecting ancestors or attributes load faults', async () => {
      const failing = ctxFor({ ancestors: () => Promise.reject(new Error('down')) });
      expect(await tests('policies.open', 'eq', true, ref('f1'), failing)).to.deep.equal([false, false, true]);
      const attrs = ctxFor({ attributes: () => Promise.reject(new Error('down')) });
      expect(await tests('policies.open', 'eq', true, ref('f1'), attrs)).to.deep.equal([false, false, true]);
    });

    it('malformed args: fault TRUE when they say fault, else FALSE', async () => {
      const ctx = ctxFor();
      const m = (a: unknown) => SCOPE_CONDITION_FILTER.matches(a, undefined, ref('f1'), ctx);
      for (const bad of [undefined, null, 'x', [], {}, { v: 2, test: 'true', type: 'org', path: 'policies.open', op: 'eq', value: true }, { v: 1, test: 'maybe', type: 'org', path: 'policies.open' }]) expect(await m(bad), JSON.stringify(bad)).to.equal(false);
      expect(await m({ v: 1, test: 'fault', type: 'org' })).to.equal(true);
      expect(await m({ v: 2, test: 'fault', type: 'org', path: 'policies.open' })).to.equal(true);
      expect(await m({ v: 1, test: 'fault', type: '', path: 'policies.open' })).to.equal(true);
      expect(await m({ v: 1, test: 'fault', type: 'org', path: 'policies.open', extra: 1 })).to.equal(true);
      for (const bad of [
        { v: 1, test: 'true', type: 'org', path: 'policies.open', op: 'eq' },
        { v: 1, test: 'true', type: 'org', path: 'policies.open', op: 'bogus', value: true },
        { v: 1, test: 'true', type: 'org', path: 'policies.open', op: 'eq', value: { a: 1 } },
        { v: 1, test: 'true', type: 'org', path: 'policies.open', op: 'eq', value: { ref: 'principal.id' } },
        { v: 1, test: 'true', type: 'org', path: 'policies..open', op: 'eq', value: true },
        { v: 1, test: 'true', type: 'org', path: 'policies.open', op: 'null', value: 'yes' },
        { v: 1, test: 'true', type: 'org', path: 'policies.level', op: 'in', value: 'gold' },
        { v: 1, test: 'true', type: 'org', path: 'policies.level', op: 'in', value: [{}] },
        { v: 1, test: 'true', type: 7, path: 'policies.open', op: 'eq', value: true },
      ]) {
        expect(await m(bad), JSON.stringify(bad)).to.equal(false);
        expect(parseScopeConditionArgs(bad), JSON.stringify(bad)).to.equal(undefined);
      }
    });

    it('parseScopeConditionArgs gives the typed args of a well-formed leaf', () => {
      expect(parseScopeConditionArgs({ v: 1, test: 'fault', type: 'org', path: 'policies.open' })).to.deep.equal({ v: 1, test: 'fault', type: 'org', path: 'policies.open' });
      expect(parseScopeConditionArgs({ v: 1, test: 'false', type: 'org', path: 'a', op: 'in', value: ['x', 1] })).to.deep.equal({ v: 1, test: 'false', type: 'org', path: 'a', op: 'in', value: ['x', 1] });
      expect(parseScopeConditionArgs({ v: 1, test: 'true', type: 'org', path: 'a', op: 'null', value: false })).to.deep.equal({ v: 1, test: 'true', type: 'org', path: 'a', op: 'null', value: false });
      expect(parseScopeConditionArgs({ v: 1, test: 'fault', type: 'org', path: 'a', op: 'eq', value: 1 })).to.equal(undefined);
    });
  });

  describe('the compiler with scopeLeaves', () => {
    const compiler = new DefaultConditionCompiler(BUILTIN_CONDITION_FUNCTIONS, [], []);
    const req = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({ principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW, region: 'eu' }, ...over });
    const leaves = (c: Condition, over: Partial<DecisionRequest> = {}) => compiler.compileParsed(compiler.parse(c), req(over), ctxFor(), { scopeLeaves: true });
    const today = (c: Condition, over: Partial<DecisionRequest> = {}) => compiler.compileParsed(compiler.parse(c), req(over), ctxFor());
    const N = (a: object): ResourceFilter => ({ op: SCOPE_CONDITION_OP, args: a } as ResourceFilter);
    const L = (path: string, op: string, value: unknown, type = 'org'): ResourceFilter => or(N({ v: 1, test: 'true', type, path, op, value }), and(not(N({ v: 1, test: 'false', type, path, op, value })), CONDITION_UNKNOWN));
    const F = (path: string, type = 'org'): ResourceFilter => N({ v: 1, test: 'fault', type, path });

    it('turns a scope comparison into the residual leaf and records its read for fault', async () => {
      const out = await leaves({ attr: 'scope.org.policies.open', eq: true });
      expect(out.filter).to.deep.equal(L('policies.open', 'eq', true));
      expect(out.fault).to.deep.equal(F('policies.open'));
      expect(out).to.deep.include({ needsSubject: false, unresolvedScope: false, cacheable: true });
      expect(Object.isFrozen((out.filter as { args: ResourceFilter[] }).args[0])).to.equal(true);
    });

    it('every operator, with null as its boolean', async () => {
      for (const [op, v] of [
        ['ne', 'x'],
        ['lt', 3],
        ['lte', 'b'],
        ['gt', 1],
        ['gte', '2'],
        ['like', 'a%'],
        ['glob', 'a/*'],
        ['wildcard', '*'],
        ['in', ['a', 1]],
        ['nin', ['a']],
      ] as const) {
        expect((await leaves({ attr: 'scope.project.a.b', [op]: v })).filter, op).to.deep.equal(L('a.b', op, v, 'project'));
      }
      expect((await leaves({ attr: 'scope.org.x', null: true })).filter).to.deep.equal(L('x', 'null', true));
      expect((await leaves({ attr: 'scope.org.x', null: false })).filter).to.deep.equal(L('x', 'null', false));
    });

    it('resolves principal, actor and env refs of the operand into the args', async () => {
      expect((await leaves({ attr: 'scope.org.level', eq: { ref: 'principal.attributes.pool' } })).filter).to.deep.equal(L('level', 'eq', 'gold'));
      expect((await leaves({ attr: 'scope.org.team', eq: { ref: 'actor.attributes.team' } }, { actor: agent })).filter).to.deep.equal(L('team', 'eq', 'red'));
      expect((await leaves({ attr: 'scope.org.region', eq: { ref: 'env.region' } })).filter).to.deep.equal(L('region', 'eq', 'eu'));
      expect((await leaves({ attr: 'scope.org.until', gt: { ref: 'env.now' } })).filter).to.deep.equal(L('until', 'gt', NOW.toISOString()));
      expect((await leaves({ attr: 'scope.org.level', in: { ref: 'principal.attributes.teams' } })).filter).to.deep.equal(L('level', 'in', ['gold', 'red']));
      expect((await leaves({ attr: 'scope.org.region', eq: { ref: 'env.region' } })).cacheable).to.equal(false);
    });

    it('an operand that is missing or does not fit gives CONDITION_UNKNOWN and still records the read', async () => {
      for (const c of [
        { attr: 'scope.org.level', eq: { ref: 'principal.attributes.missing' } },
        { attr: 'scope.org.level', eq: { ref: 'principal.attributes.obj' } },
        { attr: 'scope.org.level', eq: { ref: 'principal.attributes.teams' } },
        { attr: 'scope.org.level', in: { ref: 'principal.id' } },
        { attr: 'scope.org.level', lt: { ref: 'principal.attributes.teams' } },
      ] as Condition[]) {
        const out = await leaves(c);
        expect(out.filter, JSON.stringify(c)).to.equal(CONDITION_UNKNOWN);
        expect(out.fault, JSON.stringify(c)).to.deep.equal(F('level'));
        expect(out).to.deep.include({ needsSubject: false, unresolvedScope: false });
      }
    });

    it('fault is the OR of the distinct reads, FALSE when none', async () => {
      const out = await leaves({
        all: [
          { attr: 'scope.org.a', eq: 1 },
          { not: { attr: 'scope.org.a', gt: 3 } },
          {
            any: [
              { attr: 'scope.project.b', eq: 'x' },
              { attr: 'principal.id', eq: 'alice' },
            ],
          },
        ],
      });
      expect(out.fault).to.deep.equal(or(F('a'), F('b', 'project')));
      expect((await leaves({ attr: 'resource.a', eq: 1 })).fault).to.equal(FALSE);
      // A fold does not drop the read: the check of a row reads it before anything folds.
      const folded = await leaves({
        all: [
          { attr: 'principal.id', eq: 'bob' },
          { attr: 'scope.org.a', eq: 1 },
        ],
      });
      expect(folded.filter).to.equal(FALSE);
      expect(folded.fault).to.deep.equal(F('a'));
    });

    it('keeps today’s result for forms that are not leaves', async () => {
      const forms: [Condition, Partial<DecisionRequest>][] = [
        [{ attr: 'resource.tier', eq: { ref: 'scope.org.policies.level' } }, {}],
        [{ attr: 'principal.id', eq: { ref: 'scope.org.policies.level' } }, {}],
        [{ attr: 'scope.org.policies.level', eq: { ref: 'scope.org.policies.other' } }, {}],
        [{ fn: 'glob', args: { value: { ref: 'scope.org.policies.level' }, pattern: 'g*' } }, {}],
        [{ attr: 'scope.$global.flags.on', eq: true }, {}],
        [{ attr: 'scope.org.policies.open', eq: true }, { resource: { type: '$global' } }],
        [{ attr: 'scope.org.policies.open', eq: true }, { resource: ref('f1') }],
        [{ attr: 'scope.org.policies.level', eq: 'silver' }, { resource: ref('f1') }],
      ];
      for (const [c, over] of forms) {
        const at = JSON.stringify([c, over]);
        const was = await today(c, over).then(
          (v) => ({ v }),
          (e: Error) => ({ e: e.message }),
        );
        const now = await leaves(c, over).then(
          (v) => ({ v }),
          (e: Error) => ({ e: e.message }),
        );
        if ('e' in was) {
          expect(now, at).to.deep.equal(was);
          continue;
        }
        const { fault, ...rest } = (now as unknown as { v: Record<string, unknown> }).v;
        expect(rest, at).to.deep.equal(was.v);
        expect(fault, at).to.equal(FALSE);
      }
    });

    it('without the option nothing changes: no fault, NEEDS_SUBJECT as before', async () => {
      const out = await today({ attr: 'scope.org.policies.open', eq: true });
      expect(out).to.deep.equal({ filter: CONDITION_UNKNOWN, cacheable: true, needsSubject: true, unresolvedScope: true });
      expect(Object.hasOwn(out, 'fault')).to.equal(false);
      expect(Object.hasOwn(await compiler.compile({ attr: 'scope.org.policies.open', eq: true }, req(), ctxFor()), 'fault')).to.equal(false);
    });
  });

  describe('agreement with the compile by id (property)', () => {
    const compiler = new DefaultConditionCompiler(BUILTIN_CONDITION_FUNCTIONS, [], []);
    const SCOPE_ATTRS = ['scope.org.a', 'scope.org.b.c', 'scope.project.a'] as const;
    const value = fc.constantFrom<unknown>('a', 'b', '1', '2', '1.5', 'x/y', 1, 2, 0, 1.5, true, false, null, ['a', 1], [], { c: 'a' }, { c: 1 }, { c: null }, { c: ['a'] });
    const attrs = fc.record({ a: fc.option(value, { nil: undefined, freq: 3 }), b: fc.option(fc.oneof(value, fc.record({ c: value })), { nil: undefined, freq: 3 }) }).map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
    const scalar = fc.constantFrom<string | number | boolean>('a', 'b', '1', '2', 'x/y', 1, 2, 0, 1.5, true, false);
    const list = fc.array(fc.constantFrom<string | number>('a', 'b', '1', 1, 2), { maxLength: 3 });
    const operand = <T>(a: fc.Arbitrary<T>) => fc.oneof({ weight: 4, arbitrary: a }, { weight: 1, arbitrary: fc.constantFrom('principal.attributes.pool', 'principal.attributes.n', 'principal.attributes.teams', 'principal.attributes.missing', 'actor.id', 'env.region').map((r) => ({ ref: r })) });
    const scopeLeaf: fc.Arbitrary<Condition> = fc.tuple(fc.constantFrom(...SCOPE_ATTRS), fc.oneof(fc.tuple(fc.constantFrom('eq', 'ne'), operand(scalar)), fc.tuple(fc.constantFrom('in', 'nin'), operand(list)), fc.tuple(fc.constantFrom('lt', 'lte', 'gt', 'gte'), operand(fc.constantFrom<string | number>('a', '1', 'b', 1, 2, 1.5))), fc.tuple(fc.constantFrom('like', 'glob', 'wildcard'), operand(fc.constantFrom('a%', '_', '*', 'x/**', 'a\\'))), fc.tuple(fc.constant('null'), fc.boolean()))).map(([attr, [op, v]]) => ({ attr, [op]: v } as Condition));
    const other: fc.Arbitrary<Condition> = fc.oneof(fc.record({ attr: fc.constant('principal.attributes.pool'), eq: fc.constantFrom('gold', 'x') }), fc.record({ attr: fc.constant('resource.status'), eq: fc.constantFrom<unknown>('open', 1, { ref: 'principal.attributes.pool' }) })) as fc.Arbitrary<Condition>;
    const { tree } = fc.letrec<{ tree: Condition }>((tie) => ({
      tree: fc.oneof(
        { depthSize: 'small', maxDepth: 4, withCrossShrink: true },
        fc.oneof({ weight: 4, arbitrary: scopeLeaf }, { weight: 1, arbitrary: other }),
        fc.array(tie('tree'), { maxLength: 3 }).map((all) => ({ all })),
        fc.array(tie('tree'), { maxLength: 3 }).map((any) => ({ any })),
        tie('tree').map((c) => ({ not: c })),
      ),
    }));
    const parentOf = fc.constantFrom<ResourceRef | null>(null, { type: 'org', id: 'o1' }, { type: 'org', id: 'o2' }, { type: 'org', id: 'o3' }, { type: 'org' }, { type: 'project', id: 'p1' }, { type: 'project', id: 'p2' });
    const worldArb = fc.record({
      o1: attrs,
      o2: fc.option(attrs, { nil: null, freq: 4 }),
      p1: attrs,
      p2parent: fc.constantFrom<ResourceRef | null>(null, { type: 'org', id: 'o1' }, { type: 'org', id: 'o2' }, { type: 'org', id: 'o3' }),
      rows: fc.array(fc.record({ parent: parentOf, status: fc.constantFrom<unknown>('open', 'closed', 1, undefined) }), { minLength: 1, maxLength: 4 }),
      pool: fc.constantFrom<unknown>('gold', 'a', 1, '1', ['a', 1], undefined),
    });

    it('per row: by id throws iff fault selects it; otherwise the Kleene values agree', async () => {
      const seen = { fault: 0, true: 0, false: 0, unknown: 0 };
      await fc.assert(
        fc.asyncProperty(tree, worldArb, async (c, w) => {
          const nodes: Record<string, ResourceRef | null> = { 'org:o1': null, 'org:o2': null, 'org:o3': null, 'project:p1': { type: 'org', id: 'o1' }, 'project:p2': w.p2parent };
          w.rows.forEach((r, i) => (nodes[`file:f${i}`] = r.parent));
          const attributes = { 'org:o1': w.o1, 'org:o2': w.o2, 'org:o3': {}, 'project:p1': w.p1 } as Record<string, Readonly<Record<string, unknown>> | null>;
          const tree = new FakeScopeResolver(['org', 'project', 'file'], nodes, attributes);
          const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [tree] as never, permissions: [{ name: 'file:read', types: ['file'] }] });
          const p = compiler.parse(c);
          const who = principal('user', 'alice', { attributes: w.pool === undefined ? {} : { pool: w.pool, n: 1, teams: ['a', 'b'] } });
          const base: DecisionRequest = { principal: who, actor: agent, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW, region: 'eu' } };
          const typeLevel = await compiler.compileParsed(p, base, ctx, { scopeLeaves: true });
          expect(typeLevel.needsSubject).to.equal(false);
          for (const [i, r] of w.rows.entries()) {
            const row = { type: 'file', id: `f${i}` };
            const subject = r.status === undefined ? {} : { status: r.status };
            const env: SubjectEnv = { principal: who, ref: row, attribute: defaultAttribute, relation: () => undefined, ancestors: (x) => ctx.ancestors(x), native: (op) => (op === SCOPE_CONDITION_OP ? SCOPE_CONDITION_FILTER : undefined), ctx };
            const faults = await evaluateResidual(typeLevel.fault ?? FALSE, subject, env);
            const at = `${JSON.stringify(c)} row f${i} (${JSON.stringify(r.parent)}): ${JSON.stringify(typeLevel.filter)}`;
            const byId = await compiler.compileParsed(p, { ...base, resource: row, subject }, ctx).then(
              (v) => v,
              () => undefined,
            );
            expect(faults, `fault: ${at}`).to.equal(byId === undefined);
            if (byId === undefined) {
              seen.fault++;
              continue;
            }
            const got = await evaluateResidual(typeLevel.filter, subject, env);
            expect(got, at).to.equal(await evaluateResidual(byId.filter, subject, env));
            seen[got === undefined ? 'unknown' : got ? 'true' : 'false']++;
          }
        }),
        { numRuns: 400, seed: 4101 },
      );
      expect(
        Object.values(seen).every((n) => n > 50),
        JSON.stringify(seen),
      ).to.equal(true);
    });
  });
});
