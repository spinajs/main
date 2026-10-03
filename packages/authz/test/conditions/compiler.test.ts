import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { fakeEvaluationContext } from '@spinajs/authz-testing';

import { AuthzConfigError, CONDITION_UNKNOWN, ConditionCompiler, ConditionFunction, DefaultConditionCompiler, FALSE, ScopeResolver, TRUE } from '../../src/index.js';
import type { Condition, DecisionRequest, EvaluationContext, Principal, ResourceFilter } from '../../src/index.js';
import { FakeAdapter, FakeRow, FakeScopeResolver, principal } from '../engine/fakes.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice: Principal = principal('user', 'alice', { attributes: { pool: 'gold', n: 2, teams: ['red', 'blue'], born: new Date('2000-01-01T00:00:00.000Z') } });
const agent: Principal = principal('agent', 'ag1', { attributes: { team: 'red' } });

const O1 = { type: 'org', id: 'o1' };
const P1 = { type: 'project', id: 'p1' };
const F1 = { type: 'file', id: 'f1' };
const B1 = { type: 'branch', id: 'b1' };

class Fn extends ConditionFunction {
  readonly calls: { args: unknown; ctx: { principal: Principal; actor?: Principal; env: Readonly<Record<string, unknown>> } }[] = [];
  constructor(readonly name: string, private readonly impl: (args: unknown, ctx: { principal: Principal; actor?: Principal; env: Readonly<Record<string, unknown>> }) => unknown) {
    super();
  }
  evaluate(args: unknown, ctx: { principal: Principal; actor?: Principal; env: Readonly<Record<string, unknown>> }): boolean {
    this.calls.push({ args, ctx });
    return this.impl(args, ctx) as boolean;
  }
}

const echo = new Fn('echo', (args) => (args as { ok?: unknown }).ok === true);
const envFlag = new Fn('env.flag', (_a, ctx) => ctx.env.flag === true);
const nonBool = new Fn('non.bool', () => 'yes');
const throws = new Fn('throws', () => {
  throw new Error('fn down');
});
const seen = new Fn('seen', () => true);

const resolver = (): FakeScopeResolver => new FakeScopeResolver(['org', 'project', 'file', 'branch'], { 'org:o1': null, 'org:o2': null, 'project:p1': O1, 'file:f1': P1, 'file:f2': null, 'branch:b1': P1 }, { 'org:o1': { policies: { level: 'gold', open: true, nil: null, obj: { a: 1 } } }, 'org:o2': {}, 'branch:b1': { name: 'release/1' }, 'project:p1': { prefix: 'rel' } });

// Every type here comes from the scope resolver and none from an adapter, so resource.* may bind from attributes.
const compiler = new DefaultConditionCompiler([echo, envFlag, nonBool, throws, seen], [resolver()]);

const ctxFor = (): EvaluationContext => fakeEvaluationContext({ now: NOW, scopeResolvers: [resolver()] as never, permissions: [{ name: 'file:read', types: ['file', 'branch', 'project'] }] });

const req = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({ principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW, region: 'eu' }, ...over });

const compile = (c: Condition, over: Partial<DecisionRequest> = {}, ctx: EvaluationContext = ctxFor()) => compiler.compile(c, req(over), ctx);
const filterOf = async (c: Condition, over: Partial<DecisionRequest> = {}): Promise<ResourceFilter> => (await compile(c, over)).filter;
const cmp = (field: string, op: string, value?: unknown): ResourceFilter => (value === undefined ? { op: 'cmp', field, cmp: op } : { op: 'cmp', field, cmp: op, value }) as ResourceFilter;

describe('conditions: DefaultConditionCompiler', () => {
  describe('resource.*', () => {
    it('becomes a residual cmp on the field, every operator', async () => {
      for (const op of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard']) {
        expect(await filterOf({ attr: 'resource.status', [op]: 'open' })).to.deep.equal(cmp('status', op, 'open'));
      }
      expect(await filterOf({ attr: 'resource.team', in: ['red', 1] })).to.deep.equal(cmp('team', 'in', ['red', 1]));
      expect(await filterOf({ attr: 'resource.team', nin: ['red'] })).to.deep.equal(cmp('team', 'nin', ['red']));
      expect(await filterOf({ attr: 'resource.meta.kind', eq: 'x' })).to.deep.equal(cmp('meta.kind', 'eq', 'x'));
    });

    it('maps null: true / false to the null tests', async () => {
      expect(await filterOf({ attr: 'resource.owner', null: true })).to.deep.equal(cmp('owner', 'null'));
      expect(await filterOf({ attr: 'resource.owner', null: false })).to.deep.equal(cmp('owner', 'notnull'));
    });

    it('folds in [] and nin [] as simplify does', async () => {
      expect(await filterOf({ attr: 'resource.a', in: [] })).to.equal(FALSE);
      expect(await filterOf({ attr: 'resource.a', nin: [] })).to.equal(TRUE);
    });

    it('binds principal.*, actor.*, env.* and scope.* refs in the value now', async () => {
      expect(await filterOf({ attr: 'resource.owner', eq: { ref: 'principal.id' } })).to.deep.equal(cmp('owner', 'eq', 'alice'));
      expect(await filterOf({ attr: 'resource.team', eq: { ref: 'actor.attributes.team' } }, { actor: agent })).to.deep.equal(cmp('team', 'eq', 'red'));
      expect(await filterOf({ attr: 'resource.region', eq: { ref: 'env.region' } })).to.deep.equal(cmp('region', 'eq', 'eu'));
      expect(await filterOf({ attr: 'resource.at', lt: { ref: 'env.now' } })).to.deep.equal(cmp('at', 'lt', NOW.toISOString()));
      expect(await filterOf({ attr: 'resource.team', in: { ref: 'principal.attributes.teams' } })).to.deep.equal(cmp('team', 'in', ['red', 'blue']));
      expect(await filterOf({ attr: 'resource.tier', eq: { ref: 'scope.org.policies.level' } }, { resource: F1, subject: {} })).to.deep.equal(cmp('tier', 'eq', 'gold'));
    });

    it('a value ref that does not resolve is UNKNOWN for every row', async () => {
      expect(await filterOf({ attr: 'resource.owner', eq: { ref: 'principal.attributes.missing' } })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ attr: 'resource.owner', eq: { ref: 'principal.attributes' } })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ attr: 'resource.owner', eq: { ref: 'env.nothing' } })).to.equal(CONDITION_UNKNOWN);
    });

    it('is a constant when the request has an id, no subject, and the resource attributes hold the field', async () => {
      expect(await filterOf({ attr: 'resource.name', wildcard: 'release/*' }, { resource: B1 })).to.equal(TRUE);
      expect(await filterOf({ attr: 'resource.name', eq: 'main' }, { resource: B1 })).to.equal(FALSE);
      // not in its attributes: the row decides
      expect(await filterOf({ attr: 'resource.status', eq: 'open' }, { resource: B1 })).to.deep.equal(cmp('status', 'eq', 'open'));
      // with a subject the residual is evaluated against it
      expect(await filterOf({ attr: 'resource.name', eq: 'main' }, { resource: B1, subject: { name: 'main' } })).to.deep.equal(cmp('name', 'eq', 'main'));
    });
  });

  describe('principal.*, actor.*, env.* comparisons', () => {
    it('are decided now with the engine cmp rules', async () => {
      expect(await filterOf({ attr: 'principal.attributes.pool', eq: 'gold' })).to.equal(TRUE);
      expect(await filterOf({ attr: 'principal.attributes.pool', ne: 'gold' })).to.equal(FALSE);
      expect(await filterOf({ attr: 'principal.attributes.n', eq: '2' })).to.equal(TRUE); // canonical numeric string
      expect(await filterOf({ attr: 'principal.attributes.n', gt: 1 })).to.equal(TRUE);
      expect(await filterOf({ attr: 'principal.attributes.born', lt: '2001' })).to.equal(TRUE); // Date as ISO
      expect(await filterOf({ attr: 'principal.id', in: ['bob', 'alice'] })).to.equal(TRUE);
      expect(await filterOf({ attr: 'principal.id', like: 'al%' })).to.equal(TRUE);
      expect(await filterOf({ attr: 'actor.type', eq: 'agent' }, { actor: agent })).to.equal(TRUE);
      expect(await filterOf({ attr: 'actor.type', eq: 'user' })).to.equal(TRUE); // no actor: the principal acts
      expect(await filterOf({ attr: 'env.region', eq: 'eu' })).to.equal(TRUE);
    });

    it('are UNKNOWN on a missing value, a type mismatch or a non-scalar, never FALSE', async () => {
      expect(await filterOf({ attr: 'principal.attributes.missing', eq: 'x' })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ not: { attr: 'principal.attributes.missing', eq: 'x' } })).to.deep.equal({ op: 'not', arg: CONDITION_UNKNOWN });
      expect(await filterOf({ attr: 'principal.attributes.pool', lt: 1 })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ attr: 'principal.attributes.teams', eq: 'red' })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ attr: 'principal.attributes.pool', eq: { ref: 'env.nothing' } })).to.equal(CONDITION_UNKNOWN);
    });

    it('null tests are two-valued', async () => {
      expect(await filterOf({ attr: 'principal.attributes.missing', null: true })).to.equal(TRUE);
      expect(await filterOf({ attr: 'principal.attributes.pool', null: true })).to.equal(FALSE);
      expect(await filterOf({ attr: 'env.nothing', null: false })).to.equal(FALSE);
    });
  });

  describe('scope.*', () => {
    it('reads the nearest ancestor of the type', async () => {
      expect(await filterOf({ attr: 'scope.org.policies.open', eq: true }, { resource: F1 })).to.equal(TRUE);
      expect(await filterOf({ attr: 'scope.project.prefix', eq: 'rel' }, { resource: F1 })).to.equal(TRUE);
      expect(await filterOf({ attr: 'scope.org.policies.level', eq: 'silver' }, { resource: P1 })).to.equal(FALSE);
    });

    it('reads $global on any request, also without id', async () => {
      const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [new FakeScopeResolver(['$global'], { $global: null }, { $global: { flags: { on: true } } })] as never });
      expect((await compile({ attr: 'scope.$global.flags.on', eq: true }, {}, ctx)).filter).to.equal(TRUE);
      expect((await compile({ attr: 'scope.$global.flags.on', eq: true }, { resource: F1 }, ctx)).filter).to.equal(TRUE);
    });

    it('on a request without id needs the subject (B19); the filter is UNKNOWN meanwhile', async () => {
      const out = await compile({
        any: [
          { attr: 'resource.a', eq: 1 },
          { attr: 'scope.org.policies.open', eq: true },
        ],
      });
      expect(out.needsSubject).to.equal(true);
      expect(out.filter).to.deep.equal({ op: 'or', args: [cmp('a', 'eq', 1), CONDITION_UNKNOWN] });
      expect((await compile({ attr: 'resource.tier', eq: { ref: 'scope.org.policies.level' } })).needsSubject).to.equal(true);
      expect((await compile({ attr: 'resource.a', eq: 1 })).needsSubject).to.equal(false);
    });

    it('rejects (indeterminate, B39) on a missing or null attribute, an unknown node, no ancestor of the type, an unknown resource', async () => {
      const rejects = async (c: Condition, over: Partial<DecisionRequest>, pattern: RegExp) => {
        let error: unknown;
        await compile(c, over).catch((e) => (error = e));
        expect(error, JSON.stringify(c)).to.be.instanceOf(Error);
        expect((error as Error).message).to.match(pattern);
      };
      await rejects({ attr: 'scope.org.policies.missing', eq: true }, { resource: F1 }, /org:o1 has no such attribute/);
      await rejects({ attr: 'scope.org.policies.nil', eq: true }, { resource: F1 }, /has no such attribute/);
      await rejects({ attr: 'resource.a', eq: { ref: 'scope.org.policies.obj' } }, { resource: F1 }, /not a scalar or a literal list/);
      await rejects({ attr: 'scope.org.x', eq: 1 }, { resource: { type: 'file', id: 'f2' } }, /file:f2 has no org ancestor/);
      await rejects({ attr: 'scope.org.x', eq: 1 }, { resource: { type: 'file', id: 'nope' } }, /file:nope is an unknown resource/);
      // read even where the result would not need it
      await rejects({ any: [{ all: [] }, { attr: 'scope.org.policies.missing', eq: true }] }, { resource: F1 }, /has no such attribute/);
    });
  });

  describe('junctions', () => {
    it('all/any/not become and/or/not; empty all is TRUE and empty any FALSE', async () => {
      expect(await filterOf({ all: [] })).to.equal(TRUE);
      expect(await filterOf({ any: [] })).to.equal(FALSE);
      expect(await filterOf({ not: { any: [] } })).to.equal(TRUE);
      expect(await filterOf({ all: [{ attr: 'resource.a', eq: 1 }, { not: { attr: 'resource.b', eq: 2 } }] })).to.deep.equal({ op: 'and', args: [cmp('a', 'eq', 1), { op: 'not', arg: cmp('b', 'eq', 2) }] });
      expect(
        await filterOf({
          any: [
            { attr: 'principal.id', eq: 'alice' },
            { attr: 'resource.b', eq: 2 },
          ],
        }),
      ).to.equal(TRUE);
    });

    it('builds a wide junction as one node', async () => {
      const items = Array.from({ length: 500 }, (_, i) => ({ attr: `resource.f${i}`, eq: i }));
      const f = await filterOf({ all: items });
      expect(f.op).to.equal('and');
      expect((f as { args: unknown[] }).args).to.have.length(500);
    });
  });

  describe('functions', () => {
    it('are called with refs resolved, the principal, the actor and env', async () => {
      echo.calls.length = 0;
      expect(await filterOf({ fn: 'echo', args: { ok: true, who: { ref: 'principal.id' }, list: [{ ref: 'env.region' }] } }, { actor: agent })).to.equal(TRUE);
      expect(echo.calls[0].args).to.deep.equal({ ok: true, who: 'alice', list: ['eu'] });
      expect(echo.calls[0].ctx.principal.id).to.equal('alice');
      expect(echo.calls[0].ctx.actor?.id).to.equal('ag1');
      expect(echo.calls[0].ctx.env.region).to.equal('eu');
      expect((echo.calls[0].ctx.env.now as Date).getTime()).to.equal(NOW.getTime());
      expect(await filterOf({ fn: 'echo', args: { ok: false } })).to.equal(FALSE);
    });

    it('a function that reads env makes the result uncacheable; one that does not keeps it cacheable', async () => {
      expect(await compile({ fn: 'env.flag' })).to.deep.include({ filter: FALSE, cacheable: false });
      expect(await compile({ fn: 'seen' })).to.deep.include({ filter: TRUE, cacheable: true });
    });

    it('read resource.* args from the subject, else from the resource attributes, else need the subject', async () => {
      echo.calls.length = 0;
      await compile({ fn: 'echo', args: { name: { ref: 'resource.name' } } }, { resource: F1, subject: { name: 'x' } });
      await compile({ fn: 'echo', args: { name: { ref: 'resource.name' } } }, { resource: B1 });
      expect(echo.calls.map((c) => c.args)).to.deep.equal([{ name: 'x' }, { name: 'release/1' }]);
      const out = await compile({ not: { fn: 'echo', args: { name: { ref: 'resource.name' } } } });
      expect(out).to.deep.include({ needsSubject: true });
      expect(out.filter).to.deep.equal({ op: 'not', arg: CONDITION_UNKNOWN });
    });

    it('are UNKNOWN when an arg ref does not resolve, and not called', async () => {
      seen.calls.length = 0;
      expect(await filterOf({ fn: 'seen', args: { x: { ref: 'principal.attributes.missing' } } })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ fn: 'seen', args: { x: { ref: 'resource.missing' } } }, { resource: F1, subject: {} })).to.equal(CONDITION_UNKNOWN);
      expect(seen.calls).to.have.length(0);
    });

    it('reject on a non-boolean result or a throw', async () => {
      let error: unknown;
      await compile({ fn: 'non.bool' }).catch((e) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.match(/"non\.bool" returned string, not a boolean/);
      error = undefined;
      await compile({ fn: 'throws' }).catch((e) => (error = e));
      expect((error as Error).message).to.equal('fn down');
    });
  });

  describe('resource attributes', () => {
    it('bind resource.* only for a type with a scope resolver and no adapter', async () => {
      const row = new FakeRow('file', 'f1', { status: 'closed' });
      const adapter = new FakeAdapter(['file'], { rows: [row], scopeAttributes: { 'file:f1': { status: 'open' } } });
      const ctx = fakeEvaluationContext({ now: NOW, adapters: [adapter] as never });
      const withAdapter = new DefaultConditionCompiler([], [resolver()], [adapter]);
      // The adapter's scopeAttributes serve scope.* refs; the row, not they, decides resource.*.
      expect((await withAdapter.compile({ attr: 'resource.status', eq: 'open' }, req({ resource: F1 }), ctx)).filter).to.deep.equal(cmp('status', 'eq', 'open'));
      const noResolver = new DefaultConditionCompiler();
      expect((await noResolver.compile({ attr: 'resource.name', eq: 'main' }, req({ resource: B1 }), ctxFor())).filter).to.deep.equal(cmp('name', 'eq', 'main'));
    });
  });

  describe('operand kinds', () => {
    it('a ref value of the wrong kind for the operator is UNKNOWN, never a residual', async () => {
      expect(await filterOf({ attr: 'resource.team', in: { ref: 'principal.id' } })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ attr: 'resource.team', eq: { ref: 'principal.attributes.teams' } })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ attr: 'resource.team', like: { ref: 'principal.attributes.n' } })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ attr: 'resource.n', lt: { ref: 'env.flag' } }, { env: { now: NOW, flag: true } })).to.equal(CONDITION_UNKNOWN);
      expect(await filterOf({ attr: 'resource.n', lt: { ref: 'principal.attributes.n' } })).to.deep.equal(cmp('n', 'lt', 2));
    });
  });

  describe('unresolvedScope', () => {
    it('is set when a request without id leaves a scope.* ref unread, and only then', async () => {
      expect(await compile({ attr: 'scope.org.policies.open', eq: true })).to.deep.include({ needsSubject: true, unresolvedScope: true });
      expect(await compile({ fn: 'echo', args: { n: { ref: 'resource.name' } } })).to.deep.include({ needsSubject: true, unresolvedScope: false });
      expect(await compile({ attr: 'scope.org.policies.open', eq: true }, { resource: F1 })).to.deep.include({ needsSubject: false, unresolvedScope: false });
    });
  });

  describe('function views', () => {
    it('track the principal and actor paths a function reads for caching', async () => {
      const id = new Fn('reads.identity', (_a, ctx) => (ctx.principal as unknown as { identity?: { secret?: unknown } }).identity?.secret === 'x');
      const attrs = new Fn('reads.attributes', (_a, ctx) => ctx.principal.attributes.pool === 'gold' && ctx.principal.id === 'alice');
      const keys = new Fn('reads.keys', (_a, ctx) => Object.keys(ctx.principal).length > 0);
      const actor = new Fn('reads.actor', (_a, ctx) => ctx.actor?.onBehalfOf?.id === 'alice');
      const c = new DefaultConditionCompiler([id, attrs, keys, actor]);
      const who = { ...alice, identity: { secret: 'x' } } as Principal;
      expect(await c.compile({ fn: 'reads.identity' }, req({ principal: who }), ctxFor())).to.deep.include({ filter: TRUE, cacheable: false });
      expect(await c.compile({ fn: 'reads.attributes' }, req(), ctxFor())).to.deep.include({ filter: TRUE, cacheable: true });
      expect(await c.compile({ fn: 'reads.keys' }, req(), ctxFor())).to.deep.include({ cacheable: false });
      const lists = new DefaultConditionCompiler([new Fn('first.team', (_a, ctx) => (ctx.principal.attributes.teams as string[])[0] === 'red'), new Fn('first.role', (_a, ctx) => ctx.principal.ceiling?.roles?.[0] === 'viewer')]);
      expect(await lists.compile({ fn: 'first.team' }, req(), ctxFor())).to.deep.include({ filter: TRUE, cacheable: true });
      // The L2 key holds ceiling roles sorted, so an element read by position is not keyed.
      expect(await lists.compile({ fn: 'first.role' }, req({ principal: { ...alice, ceiling: { roles: ['viewer'] } } as Principal }), ctxFor())).to.deep.include({ filter: TRUE, cacheable: false });
      expect(await c.compile({ fn: 'reads.actor' }, req({ actor: { ...agent, onBehalfOf: alice } }), ctxFor())).to.deep.include({ filter: TRUE, cacheable: false });
      const actorType = new DefaultConditionCompiler([new Fn('actor.type', (_a, ctx) => ctx.actor?.type === 'user')]);
      // Without an actor the principal acts itself, as actor.* refs read it.
      expect((await actorType.compile({ fn: 'actor.type' }, req(), ctxFor())).filter).to.equal(TRUE);
    });

    it('are read-only, and hand out copies of Dates', async () => {
      const now = new Date(NOW.getTime());
      const writes = new Fn('writes.env', (_a, ctx) => {
        (ctx.env as Record<string, unknown>).region = 'us';
        return true;
      });
      const moves = new Fn('moves.now', (_a, ctx) => {
        (ctx.env.now as Date).setTime(0);
        (ctx.principal.attributes.born as Date).setTime(0);
        return true;
      });
      const c = new DefaultConditionCompiler([writes, moves]);
      let error: unknown;
      await c.compile({ fn: 'writes.env' }, req(), ctxFor()).catch((e) => (error = e));
      expect(error).to.be.instanceOf(TypeError);
      const r = req({ env: { now } });
      expect((await c.compile({ all: [{ fn: 'moves.now' }, { attr: 'env.now', eq: NOW.toISOString() }] }, r, ctxFor())).filter).to.equal(TRUE);
      expect(now.getTime()).to.equal(NOW.getTime());
      expect((alice.attributes.born as Date).getTime()).to.not.equal(0);
    });

    it('work on a frozen principal', async () => {
      const frozen = Object.freeze({ ...alice, attributes: Object.freeze({ ...alice.attributes }) }) as Principal;
      const c = new DefaultConditionCompiler([new Fn('pool', (_a, ctx) => ctx.principal.attributes.pool === 'gold')]);
      expect((await c.compile({ fn: 'pool' }, req({ principal: frozen }), ctxFor())).filter).to.equal(TRUE);
    });
  });

  describe('cacheable', () => {
    it('is false when env is read, or a principal path outside the L2 key', async () => {
      expect((await compile({ attr: 'resource.owner', eq: { ref: 'principal.id' } })).cacheable).to.equal(true);
      expect((await compile({ attr: 'principal.attributes.pool', eq: 'gold' })).cacheable).to.equal(true);
      expect((await compile({ attr: 'scope.org.policies.open', eq: true }, { resource: F1 })).cacheable).to.equal(true);
      expect((await compile({ attr: 'env.region', eq: 'eu' })).cacheable).to.equal(false);
      expect((await compile({ attr: 'resource.at', lt: { ref: 'env.now' } })).cacheable).to.equal(false);
      expect((await compile({ attr: 'principal.identity.x', eq: 1 })).cacheable).to.equal(false);
    });
  });

  describe('setup', () => {
    it('rejects an unknown function or a malformed condition through the promise', async () => {
      let error: unknown;
      await compile({ fn: 'nope' } as Condition).catch((e) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      error = undefined;
      await compile({ attr: 'row.a', eq: 1 } as Condition).catch((e) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
    });

    it('parses a frozen condition object once, an unfrozen one each time', () => {
      const frozen: Condition = Object.freeze({ attr: 'resource.a', eq: 1 });
      expect(compiler.parse(frozen)).to.equal(compiler.parse(frozen));
      const open = { attr: 'resource.a', eq: 1 } as { attr: string; eq: unknown };
      const first = compiler.parse(open);
      open.eq = 2;
      expect(compiler.parse(open)).to.not.equal(first);
      expect(compiler.parse(open)).to.deep.include({ operand: { kind: 'literal', value: 2 } });
    });

    it('refuses two functions with one name, or one without a name', () => {
      expect(() => new DefaultConditionCompiler([echo, new Fn('echo', () => true)])).to.throw(AuthzConfigError, /two condition functions are named "echo"/);
      expect(() => new DefaultConditionCompiler([new Fn('', () => true)])).to.throw(AuthzConfigError, /needs a name/);
      expect([...compiler.functionNames()].sort()).to.deep.equal(['echo', 'env.flag', 'non.bool', 'seen', 'throws']);
    });

    it('is the ConditionCompiler registered in DI, a fresh one per resolve', async () => {
      // The kit loads the lib copy of the core next to this src copy, so the class is matched by name.
      const a = await DI.resolve(ConditionCompiler);
      expect(a.constructor.name).to.equal(DefaultConditionCompiler.name);
      expect(await DI.resolve(ConditionCompiler)).to.not.equal(a);
    });

    it('built for a child container, sees the functions and resolvers registered along its lineage by then', async () => {
      class Late extends ConditionFunction {
        readonly name = 'late.fn';
        evaluate(): boolean {
          return true;
        }
      }
      class BranchResolver extends ScopeResolver {
        readonly types = ['branch'];
        async ancestors() {
          return null;
        }
      }
      const child = DI.child();
      child.register(Late).as(ConditionFunction);
      child.register(BranchResolver).as(ScopeResolver);
      const c = (await child.resolve(ConditionCompiler)) as DefaultConditionCompiler;
      expect([...c.functionNames()]).to.include('late.fn');
      const out = await c.compile({ attr: 'resource.name', eq: 'release/1' }, req({ resource: B1 }), ctxFor());
      expect(out.filter).to.deep.equal(TRUE);
    });
  });
});
