import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import { sanitizeVote } from '../../src/engine/vote.js';
import { LruDecisionCache } from '../../src/engine/cache.js';
import { l1Key } from '../../src/engine/context.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { AuthzConfigError, CORE_FILTER_OPS, Combinator, FALSE, GLOBAL, SYSTEM, TRUE, UNATTENDED, UnknownPermission, and, not, or, resourceKey } from '../../src/index.js';
import type { Decision, DecisionRequest, EvaluationContext, Principal, ResourceFilter, Vote } from '../../src/index.js';
import { FakeAdapter, FakeNativeFilter, FakeRelation, FakeRow, FakeScopeResolver, RecordingAudit, RecordingLog, StaticModel, deny, fakeClock, permit, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const REG = registryOf([
  { name: 'doc:read', types: ['doc'] },
  { name: 'doc:write', types: ['doc'] },
  { name: 'fs:read', types: ['file', 'dir'] },
  { name: 'org:view', types: ['org'] },
]);

const alice = principal('user', 'alice');
const owner = (): ResourceFilter => ({ op: 'cmp', field: 'owner', cmp: 'eq', value: { ref: 'principal.id' } });

let log: RecordingLog;
let audit: RecordingAudit;
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  log = new RecordingLog();
  audit = new RecordingAudit();
  clock = fakeClock();
});

const make = (options: Partial<AuthorizerOptions> = {}): Authorizer => new Authorizer({ domain: 'root', models: [], registry: REG, clock: clock.clock, log, audit, ...options });

const tick = () => new Promise((r) => setTimeout(r, 5));

function deepFrozen(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null || typeof v !== 'object' || seen.has(v)) return true;
  seen.add(v);
  if (!Object.isFrozen(v)) return false;
  return Object.values(v as object).every((x) => deepFrozen(x, seen));
}

describe('Authorizer', () => {
  describe('construction', () => {
    it('rejects two adapters for one type', () => {
      expect(() => make({ adapters: [new FakeAdapter(['doc']), new FakeAdapter(['doc', 'file'])] })).to.throw(AuthzConfigError, /doc/);
    });

    it('rejects two scope resolvers for one type', () => {
      expect(() => make({ scopeResolvers: [new FakeScopeResolver(['org']), new FakeScopeResolver(['org'])] })).to.throw(AuthzConfigError, /org/);
    });

    it('lets an adapter and a scope resolver share a type (the adapter wins)', async () => {
      const adapter = new FakeAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')] });
      const resolver = new FakeScopeResolver(['doc'], {});
      const a = make({ adapters: [adapter], scopeResolvers: [resolver], models: [new StaticModel('m', { vote: permit() })] });
      const d = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
      expect(d.allowed).to.equal(true);
      expect(adapter.ancestorCalls).to.have.length(1);
      expect(resolver.ancestorCalls).to.have.length(0);
    });

    it('rejects a duplicate relation (option list and adapter relations)', () => {
      const r1 = new FakeRelation('doc', 'owner', () => true);
      const r2 = new FakeRelation('doc', 'owner', () => true);
      expect(() => make({ relations: [r1], adapters: [new FakeAdapter(['doc'], { relations: [r2] })] })).to.throw(AuthzConfigError, /owner/);
      expect(() => make({ relations: [r1, r2] })).to.throw(AuthzConfigError, /owner/);
    });

    it('rejects a duplicate native filter', () => {
      expect(() => make({ nativeFilters: [new FakeNativeFilter('native:x', () => true), new FakeNativeFilter('native:x', () => true)] })).to.throw(AuthzConfigError, /native:x/);
    });

    it('rejects a custom combinator named like a built-in', () => {
      class Fake extends Combinator {
        readonly name = 'deny-overrides';
        combine() {
          return { allow: TRUE };
        }
      }
      expect(() => make({ combinators: [new Fake()] })).to.throw(AuthzConfigError, /deny-overrides/);
    });

    it('rejects route compile errors (unknown algorithm)', () => {
      expect(() => make({ combine: { default: { algorithm: 'nope' } } })).to.throw(AuthzConfigError, /nope/);
    });

    it('uses a custom combinator named in the combine config', async () => {
      class AlwaysFalse extends Combinator {
        readonly name = 'never';
        combine() {
          return { allow: FALSE };
        }
      }
      const a = make({ combinators: [new AlwaysFalse()], combine: { default: { algorithm: 'never' } }, models: [new StaticModel('m', { vote: permit() })] });
      const d = await a.check({ principal: alice, permission: 'doc:read' });
      expect(d.allowed).to.equal(false);
    });

    it('denies with model_error when a custom combinator throws or returns a malformed allow', async () => {
      class Broken extends Combinator {
        readonly name = 'broken';
        combine(): { allow: ResourceFilter } {
          throw new Error('boom');
        }
      }
      class Malformed extends Combinator {
        readonly name = 'malformed';
        combine() {
          return { allow: { op: 'bogus' } as unknown as ResourceFilter };
        }
      }
      for (const [c, name] of [
        [new Broken(), 'broken'],
        [new Malformed(), 'malformed'],
      ] as const) {
        const a = make({ combinators: [c], combine: { default: { algorithm: name } }, models: [new StaticModel('m', { vote: permit() })] });
        const d = await a.check({ principal: alice, permission: 'doc:read' });
        expect(d.allowed, name).to.equal(false);
        expect(d.reason?.code).to.equal('model_error');
      }
    });

    it('denies with model_error when a custom combinator returns a promise, leaving no unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const guard = (e: unknown) => unhandled.push(e);
      process.on('unhandledRejection', guard);
      try {
        class Async extends Combinator {
          readonly name = 'async';
          combine(): never {
            return Promise.reject(new Error('combinator rejected')) as never;
          }
        }
        const a = make({ combinators: [new Async()], combine: { default: { algorithm: 'async' } }, models: [new StaticModel('m', { vote: permit() })] });
        const d = await a.check({ principal: alice, permission: 'doc:read' });
        await tick();
        expect(d.allowed).to.equal(false);
        expect(d.reason?.code).to.equal('model_error');
        expect(unhandled).to.deep.equal([]);
        expect(log.at('error').some((e) => /synchronous/.test(e.message))).to.equal(true);
      } finally {
        process.off('unhandledRejection', guard);
      }
    });

    it('exposes models() and routes()', () => {
      const m = new StaticModel('m');
      const a = make({ models: [m] });
      expect(a.models()).to.deep.equal([m]);
      expect(Object.isFrozen(a.models())).to.equal(true);
      expect(a.routes().get('doc:read', 'doc')?.models).to.deep.equal([m]);
      expect(a.domain).to.equal('root');
    });

    it('rejects an invalid modelTimeoutMs', () => {
      expect(() => make({ config: { modelTimeoutMs: 0 } })).to.throw(AuthzConfigError);
      expect(() => make({ config: { modelTimeoutMs: Number.NaN } })).to.throw(AuthzConfigError);
    });

    it('validates scopeAttributes: an object of schemas (indexed at construction) and a store with get()', () => {
      const bad = (scopeAttributes: unknown) => () => make({ scopeAttributes: scopeAttributes as AuthorizerOptions['scopeAttributes'] });
      expect(bad(5)).to.throw(AuthzConfigError, /root.*scopeAttributes/);
      expect(bad(null)).to.throw(AuthzConfigError, /scopeAttributes/);
      expect(bad({ schemas: 'org' })).to.throw(AuthzConfigError, /root.*list/);
      expect(bad({ schemas: [{ scopeType: '', schema: {}, defaults: {} }] })).to.throw(AuthzConfigError, /scopeType/);
      expect(bad({ schemas: [{ scopeType: 'org', schema: {}, defaults: new Date() }] })).to.throw(AuthzConfigError, /plain object/);
      expect(
        bad({
          schemas: [
            { scopeType: 'org', schema: {}, defaults: {} },
            { scopeType: 'org', schema: {}, defaults: {} },
          ],
        }),
      ).to.throw(AuthzConfigError, /two scope attribute schemas.*org/);
      expect(bad({ store: {} })).to.throw(AuthzConfigError, /store/);
      expect(bad({ store: { get: 'x' } })).to.throw(AuthzConfigError, /store/);
      expect(() => make({ scopeAttributes: {} })).not.to.throw();
      expect(() => make({ scopeAttributes: { schemas: [{ scopeType: 'org', schema: {}, defaults: { a: 1 } }], store: { get: async () => ({}), version: async () => '1' } } })).not.to.throw();
    });

    it('reads schema defaults once, at construction', async () => {
      const defaults = { plan: 'free' };
      let seen: unknown;
      const m = new StaticModel('m', {
        vote: async (_req, ctx) => {
          seen = await ctx.attributes({ type: 'org', id: 'o1' });
          return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      const a = make({ models: [m], scopeAttributes: { schemas: [{ scopeType: 'org', schema: {}, defaults }] } });
      defaults.plan = 'changed';
      await a.check({ principal: alice, permission: 'doc:read' });
      expect(seen).to.deep.equal({ plan: 'free' });
    });
  });

  describe('check: permission and resource', () => {
    it('B02: an unknown permission throws', async () => {
      const a = make({ models: [new StaticModel('m', { vote: permit() })] });
      await expectReject(a.check({ principal: alice, permission: 'doc:delete' }), UnknownPermission);
      await expectReject(a.check({ principal: alice, permission: 'not a name' }), AuthzConfigError);
    });

    it('D10: a type outside def.types throws; $global is accepted', async () => {
      const a = make({ models: [new StaticModel('m', { vote: permit() })] });
      await expectReject(a.check({ principal: alice, permission: 'doc:read', resource: { type: 'file' } }), AuthzConfigError);
      const d = await a.check({ principal: alice, permission: 'doc:read', resource: GLOBAL });
      expect(d.allowed).to.equal(true);
      expect(d.resource).to.deep.equal({ type: '$global' });
    });

    it('resource absent ⇒ { type: def.resource }', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const d = await make({ models: [m] }).check({ principal: alice, permission: 'doc:read' });
      expect(d.resource).to.deep.equal({ type: 'doc' });
      expect(m.calls[0].req.resource).to.deep.equal({ type: 'doc' });
      expect(m.calls[0].req).to.not.have.property('subject');
    });

    it('an object an adapter accepts goes through refOf and becomes the subject', async () => {
      const row = new FakeRow('doc', 'd1', { owner: 'alice' });
      const adapter = new FakeAdapter(['doc'], { rows: [row] });
      const m = new StaticModel('m', { vote: permit() });
      const d = await make({ adapters: [adapter], models: [m] }).check({ principal: alice, permission: 'doc:read', resource: row });
      expect(adapter.refOfCalls).to.deep.equal([row]);
      expect(d.resource).to.deep.equal({ type: 'doc', id: 'd1' });
      expect(m.calls[0].req.subject).to.equal(row);
      expect(m.calls[0].req.resource).to.deep.equal({ type: 'doc', id: 'd1' });
    });

    it('an accepted object keeps an explicit subject; an async refOf is awaited', async () => {
      const row = new FakeRow('doc', 'd1');
      const adapter = new FakeAdapter(['doc'], { rows: [row], asyncRefOf: true });
      const m = new StaticModel('m', { vote: permit() });
      const other = { owner: 'bob' };
      const d = await make({ adapters: [adapter], models: [m] }).check({ principal: alice, permission: 'doc:read', resource: row, subject: other });
      expect(d.resource).to.deep.equal({ type: 'doc', id: 'd1' });
      expect(m.calls[0].req.subject).to.equal(other);
    });

    it('the first adapter (option order) that accepts wins', async () => {
      const row = new FakeRow('doc', 'd1');
      const first = new FakeAdapter(['doc'], { rows: [row] });
      const second = new FakeAdapter(['file'], {});
      second.accepts = ((t: unknown) => t instanceof FakeRow) as typeof second.accepts;
      await make({ adapters: [first, second], models: [new StaticModel('m', { vote: permit() })] }).check({ principal: alice, permission: 'doc:read', resource: row });
      expect(first.refOfCalls).to.have.length(1);
      expect(second.refOfCalls).to.have.length(0);
    });

    it('a ref-shaped object is the ref; id null ⇒ no id', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const a = make({ models: [m] });
      const d1 = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'x' } });
      expect(d1.resource).to.deep.equal({ type: 'doc', id: 'x' });
      expect(m.calls[0].req).to.not.have.property('subject');
      const d2 = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: null } });
      expect(d2.resource).to.deep.equal({ type: 'doc' });
      expect(d2.resource).to.not.have.property('id');
    });

    it('an unacceptable resource throws', async () => {
      const a = make({ models: [new StaticModel('m', { vote: permit() })] });
      for (const resource of [{ type: 'doc', id: 'x', extra: 1 }, { type: 'doc', id: 5 }, { type: 7 }, { id: 'x' }, { type: 'doc', id: undefined }, [], new Map(), 'doc', 5, null]) {
        await expectReject(a.check({ principal: alice, permission: 'doc:read', resource: resource as object }), AuthzConfigError);
      }
    });

    it('unknown resource (ancestors null) ⇒ unknown_resource, no model called', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const adapter = new FakeAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')] });
      const d = await make({ adapters: [adapter], models: [m] }).check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'missing' } });
      expect(d.allowed).to.equal(false);
      expect(d.residual).to.equal(FALSE);
      expect(d.reason).to.deep.include({ code: 'unknown_resource' });
      expect(m.calls).to.have.length(0);
    });

    it('unknown resource through a scope resolver; a type with neither is known', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const resolver = new FakeScopeResolver(['org'], { 'org:o1': null });
      const a = make({ scopeResolvers: [resolver], models: [m] });
      expect((await a.check({ principal: alice, permission: 'org:view', resource: { type: 'org', id: 'o1' } })).allowed).to.equal(true);
      expect((await a.check({ principal: alice, permission: 'org:view', resource: { type: 'org', id: 'o2' } })).reason?.code).to.equal('unknown_resource');
      expect((await a.check({ principal: alice, permission: 'fs:read', resource: { type: 'file', id: 'f1' } })).allowed).to.equal(true);
    });

    it('rejects when the adapter answers malformed ancestors', async () => {
      const adapter = new FakeAdapter(['doc']);
      adapter.ancestors = async () => [{ type: 5 }] as never;
      await expectReject(make({ adapters: [adapter], models: [new StaticModel('m', { vote: permit() })] }).check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'x' } }), AuthzConfigError);
    });
  });

  describe('check: principal gate', () => {
    it('UNATTENDED, a missing principal and forged system/unattended principals ⇒ unattended, no models', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const a = make({ models: [m] });
      for (const p of [UNATTENDED, undefined, null, 'alice', principal('system', 'system'), principal('unattended', 'x'), { type: 5, id: 'x' }]) {
        const d = await a.check({ principal: p as never, permission: 'doc:read' });
        expect(d.allowed).to.equal(false);
        expect(d.reason).to.deep.include({ code: 'unattended' });
      }
      expect(m.calls).to.have.length(0);
    });

    it('SYSTEM ⇒ allowed TRUE, no models, audited, neverRead hidden', async () => {
      const m = new StaticModel('m', { vote: deny() });
      const d = await make({ models: [m] }).check({ principal: SYSTEM, permission: 'doc:read' });
      expect(d.allowed).to.equal(true);
      expect(d.residual).to.equal(TRUE);
      expect(d.principal).to.deep.equal({ type: 'system', id: 'system' });
      expect(d.fields.write).to.deep.equal(['*', '!Password']);
      expect(d.fields.read).to.include('*');
      expect(d.fields.read).to.include('!Password');
      expect(m.calls).to.have.length(0);
      expect(audit.kinds()).to.deep.equal(['system']);
    });
  });

  describe('vote hygiene', () => {
    const indeterminate = async (model: StaticModel, extra: Partial<AuthorizerOptions> = {}) => {
      const d = await make({ models: [model, new StaticModel('other', { vote: permit() })], ...extra }).explain({ principal: alice, permission: 'doc:read' });
      expect(d.allowed, 'allowed').to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'model_error', model: model.name });
      const vote = d.trace!.votes.find((v) => v.model === model.name)!;
      expect(vote.error, 'vote.error').to.be.a('string');
      expect(
        log.at('error').some((e) => e.message.includes(model.name) || e.args.some((x) => String(x).includes(model.name))),
        'logged',
      ).to.equal(true);
      return vote;
    };

    it('evaluate throws', async () => {
      await indeterminate(new StaticModel('bad', { throws: new Error('kaput') }));
    });

    it('evaluate rejects', async () => {
      await indeterminate(new StaticModel('bad', { vote: () => Promise.reject(new Error('kaput')) }));
    });

    it('the vote sets error', async () => {
      await indeterminate(new StaticModel('bad', { vote: { permitWhen: TRUE, error: 'store down' } }));
    });

    it('result not an object', async () => {
      await indeterminate(new StaticModel('bad', { vote: () => 42 }));
      await indeterminate(new StaticModel('bad2', { vote: () => null }));
    });

    it('permitWhen / denyWhen not filter-shaped', async () => {
      await indeterminate(new StaticModel('bad', { vote: { permitWhen: { op: 'bogus' } as never } }));
      await indeterminate(new StaticModel('bad2', { vote: { denyWhen: undefined as never } }));
      await indeterminate(new StaticModel('bad3', { vote: { permitWhen: { op: 'and', args: 'x' } as never } }));
      await indeterminate(new StaticModel('bad4', { vote: { permitWhen: { op: 'cmp', field: 'a', cmp: 'eq', value: new Date() } as never } }));
    });

    it('an op the model did not declare (permitWhen, denyWhen, denies[].when)', async () => {
      const caps = { residuals: ['cmp'] as const };
      const rel: ResourceFilter = { op: 'relation', relation: 'owner' };
      await indeterminate(new StaticModel('bad', { capabilities: caps, vote: { permitWhen: rel } }));
      await indeterminate(new StaticModel('bad2', { capabilities: caps, vote: { denyWhen: { op: 'not', arg: rel } } }));
      await indeterminate(new StaticModel('bad3', { capabilities: caps, vote: { denyWhen: FALSE, denies: [{ when: rel, reason: { code: 'x' } }] } }));
      await indeterminate(new StaticModel('bad4', { capabilities: caps, vote: { permitWhen: { op: 'native:geo' } } }));
    });

    it('structural ops are always allowed', async () => {
      const m = new StaticModel('m', { capabilities: { residuals: [] }, vote: { permitWhen: { op: 'and', args: [TRUE, { op: 'not', arg: FALSE }] } } });
      const d = await make({ models: [m] }).check({ principal: alice, permission: 'doc:read' });
      expect(d.allowed).to.equal(true);
    });

    it("a permit without the 'permit' effect, a deny without 'deny'", async () => {
      await indeterminate(new StaticModel('bad', { capabilities: { effects: ['deny'] }, vote: permit() }));
      await indeterminate(new StaticModel('bad2', { capabilities: { effects: ['permit'] }, vote: { permitWhen: TRUE, denyWhen: owner() } }));
      const ok = new StaticModel('ok', { capabilities: { effects: ['permit'] }, vote: { permitWhen: TRUE, denyWhen: { op: 'and', args: [FALSE, owner()] } } });
      expect((await make({ models: [ok] }).check({ principal: alice, permission: 'doc:read' })).allowed).to.equal(true);
    });

    it('malformed denies, reason, roles or fields', async () => {
      await indeterminate(new StaticModel('bad', { vote: { denies: 'x' as never } }));
      await indeterminate(new StaticModel('bad2', { vote: { denies: [{ when: TRUE, reason: { nocode: 1 } }] as never } }));
      await indeterminate(new StaticModel('bad3', { vote: { reason: { code: 5 } as never } }));
      await indeterminate(new StaticModel('bad4', { vote: { roles: { project: 3 } as never } }));
      await indeterminate(new StaticModel('bad5', { vote: { fields: { hide: 'Password' } as never } }));
    });

    it('a model cannot clear its own depth fault', async () => {
      let attempts = 0;
      const rec = new StaticModel('rec', {
        vote: async (req, ctx) => {
          try {
            await ctx.check({ principal: req.principal, permission: req.permission, resource: req.resource });
          } catch {
            try {
              (ctx as unknown as { fault: unknown }).fault = undefined;
            } catch {
              attempts++;
            }
          }
          return { model: 'rec', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      const seen: Decision[] = [];
      const top = new StaticModel('top', {
        applies: (def) => def.name === 'doc:write',
        vote: async (req, ctx) => {
          seen.push(await ctx.check({ principal: req.principal, permission: 'doc:read', resource: req.resource }));
          return { model: 'top', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      rec.applies = (def) => def.name === 'doc:read';
      await make({ models: [rec, top] }).check({ principal: alice, permission: 'doc:write' });
      expect(attempts).to.equal(1);
      expect(rec.calls).to.have.length(8);
      expect(seen[0].allowed).to.equal(true);
    });

    it('stamps model, treats a non-boolean cacheable as false', async () => {
      const m = new StaticModel('m', { vote: () => ({ model: 'impostor', permitWhen: TRUE, denyWhen: FALSE, cacheable: 'yes' }) });
      const d = await make({ models: [m] }).explain({ principal: alice, permission: 'doc:read' });
      expect(d.trace!.votes[0].model).to.equal('m');
      expect(d.trace!.votes[0].cacheable).to.equal(false);
      expect(d.allowed).to.equal(true);
    });

    it('B04 under deny-overrides even when another model permits', async () => {
      const d = await make({ models: [new StaticModel('a', { vote: permit() }), new StaticModel('b', { throws: new Error('x') })] }).check({ principal: alice, permission: 'doc:read' });
      expect(d.allowed).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'model_error', model: 'b' });
    });

    it('times out a slow model; the late result is ignored', async () => {
      const slow = new StaticModel('slow', { vote: permit(), delayMs: 80 });
      const d = await make({ models: [slow], config: { modelTimeoutMs: 15 } }).check({ principal: alice, permission: 'doc:read' });
      expect(d.allowed).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'model_error', model: 'slow' });
      expect(log.at('error').length).to.be.greaterThan(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(d.allowed).to.equal(false);
    });

    it('a late rejection after the timeout is caught', async () => {
      const unhandled: unknown[] = [];
      const guard = (e: unknown) => unhandled.push(e);
      process.on('unhandledRejection', guard);
      try {
        const late = new StaticModel('late', { vote: () => new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 40)) });
        const d = await make({ models: [late], config: { modelTimeoutMs: 10 } }).check({ principal: alice, permission: 'doc:read' });
        expect(d.reason?.code).to.equal('model_error');
        await new Promise((r) => setTimeout(r, 80));
        expect(unhandled).to.deep.equal([]);
      } finally {
        process.off('unhandledRejection', guard);
      }
    });
  });

  describe('evaluation order and short-circuits', () => {
    it('permit-overrides stops at a decided permit; not on a conditional one', async () => {
      const m1 = new StaticModel('m1', { vote: permit() });
      const m2 = new StaticModel('m2', { vote: permit() });
      await make({ models: [m1, m2], combine: { default: { algorithm: 'permit-overrides' } } }).check({ principal: alice, permission: 'doc:read' });
      expect(m2.calls).to.have.length(0);
      const c1 = new StaticModel('c1', { vote: permit(owner()) });
      const c2 = new StaticModel('c2', { vote: permit() });
      await make({ models: [c1, c2], combine: { default: { algorithm: 'permit-overrides' } } }).check({ principal: alice, permission: 'doc:read' });
      expect(c2.calls).to.have.length(1);
    });

    it('first-applicable stops at the first model that permits or denies', async () => {
      const m1 = new StaticModel('m1', { vote: deny() });
      const m2 = new StaticModel('m2', { vote: permit() });
      const d = await make({ models: [m1, m2], combine: { default: { algorithm: 'first-applicable' } } }).check({ principal: alice, permission: 'doc:read' });
      expect(d.allowed).to.equal(false);
      expect(m2.calls).to.have.length(0);
      const n1 = new StaticModel('n1');
      const n2 = new StaticModel('n2', { vote: permit() });
      const d2 = await make({ models: [n1, n2], combine: { default: { algorithm: 'first-applicable' } } }).check({ principal: alice, permission: 'doc:read' });
      expect(d2.allowed).to.equal(true);
      expect(n2.calls).to.have.length(1);
    });

    it('deny-overrides evaluates every model, concurrently', async () => {
      const waiting: ((v: unknown) => void)[] = [];
      const m1 = new StaticModel('m1', { vote: () => new Promise((resolve) => waiting.push(() => resolve({ model: 'm1', permitWhen: TRUE, denyWhen: FALSE, cacheable: true }))) });
      const m2 = new StaticModel('m2', {
        vote: () => {
          for (const w of waiting) w(undefined);
          return { model: 'm2', permitWhen: FALSE, denyWhen: TRUE, cacheable: true };
        },
      });
      const d = await make({ models: [m1, m2], config: { modelTimeoutMs: 200 } }).explain({ principal: alice, permission: 'doc:read' });
      expect(d.trace!.votes.map((v) => v.error)).to.deep.equal([undefined, undefined]);
      expect(d.allowed).to.equal(false);
      expect(m2.calls).to.have.length(1);
    });

    it('explain evaluates every model', async () => {
      for (const algorithm of ['permit-overrides', 'first-applicable']) {
        const m1 = new StaticModel('m1', { vote: permit() });
        const m2 = new StaticModel('m2', { vote: permit() });
        const d = await make({ models: [m1, m2], combine: { default: { algorithm } } }).explain({ principal: alice, permission: 'doc:read' });
        expect(m2.calls, algorithm).to.have.length(1);
        expect(d.trace!.votes).to.have.length(2);
      }
    });

    it('skips a model whose principalTypes lacks the principal type', async () => {
      const svc = new StaticModel('svc', { capabilities: { principalTypes: ['service'] }, vote: permit() });
      const a = make({ models: [svc] });
      const d = await a.check({ principal: alice, permission: 'doc:read' });
      expect(svc.calls).to.have.length(0);
      expect(d.reason?.code).to.equal('no_access');
      expect((await a.check({ principal: principal('service', 's1'), permission: 'doc:read' })).allowed).to.equal(true);
    });
  });

  describe('EvaluationContext', () => {
    it('nested ctx.check shares the request scope', async () => {
      const adapter = new FakeAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')] });
      const reader = new StaticModel('reader', {
        applies: (def) => def.name === 'doc:read',
        vote: async (req, ctx) => {
          const d = await ctx.check({ principal: req.principal, permission: 'doc:write', resource: req.resource });
          return { model: 'reader', permitWhen: d.allowed ? TRUE : FALSE, denyWhen: FALSE, cacheable: true };
        },
      });
      const writer = new StaticModel('writer', { applies: (def) => def.name === 'doc:write', vote: permit() });
      const d = await make({ adapters: [adapter], models: [reader, writer] }).check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
      expect(d.allowed).to.equal(true);
      expect(writer.calls).to.have.length(1);
      expect(adapter.ancestorCalls).to.have.length(1);
      expect(audit.entries).to.have.length(0);
    });

    it('nested checks deeper than 8 make the calling vote indeterminate', async () => {
      const seen: Decision[] = [];
      const rec = new StaticModel('rec', {
        vote: async (req, ctx) => {
          try {
            seen.push(await ctx.check({ principal: req.principal, permission: req.permission, resource: req.resource }));
          } catch {
            // the model swallows the refusal; the engine must not
          }
          return { model: 'rec', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      const d = await make({ models: [rec] }).check({ principal: alice, permission: 'doc:read' });
      expect(rec.calls).to.have.length(9);
      expect(seen[0].allowed).to.equal(false);
      expect(seen[0].reason).to.deep.equal({ code: 'model_error', model: 'rec' });
      expect(seen.slice(1).every((x) => x.allowed)).to.equal(true);
      expect(d.allowed).to.equal(true);
    });

    it('ctx.cache is private per model and lives as long as the scope', async () => {
      const caches: Record<string, Map<string, unknown>[]> = { a: [], b: [] };
      const model = (name: 'a' | 'b') =>
        new StaticModel(name, {
          vote: (_req, ctx) => {
            caches[name].push(ctx.cache);
            ctx.cache.set('k', name);
            return { model: name, permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
          },
        });
      const a = make({ models: [model('a'), model('b')] });
      const scope = { cache: new Map<string, unknown>() };
      await a.check({ principal: alice, permission: 'doc:read' }, scope);
      await a.check({ principal: alice, permission: 'doc:write' }, scope);
      await a.check({ principal: alice, permission: 'doc:read' });
      expect(caches.a[0]).to.not.equal(caches.b[0]);
      expect(caches.a[0]).to.equal(caches.a[1]);
      expect(caches.a[2]).to.not.equal(caches.a[0]);
      expect(caches.a[0].get('k')).to.equal('a');
      expect([...scope.cache.keys()].every((k) => k.startsWith('\u0000'))).to.equal(true);
    });

    it('ctx.ancestors is memoised per ref per scope', async () => {
      const adapter = new FakeAdapter(['doc', 'folder'], { rows: [new FakeRow('doc', 'd1', {}, { type: 'folder', id: 'f1' }), new FakeRow('folder', 'f1')] });
      const results: unknown[] = [];
      const m = new StaticModel('m', {
        vote: async (req, ctx) => {
          results.push(await ctx.ancestors(req.resource));
          results.push(await ctx.ancestors(req.resource));
          results.push(await ctx.ancestors({ type: 'folder', id: 'f1' }));
          return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      const a = make({ adapters: [adapter], models: [m] });
      const scope = { cache: new Map<string, unknown>() };
      await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } }, scope);
      await a.check({ principal: alice, permission: 'doc:write', resource: { type: 'doc', id: 'd1' } }, scope);
      expect(adapter.ancestorCalls).to.deep.equal([
        { type: 'doc', id: 'd1' },
        { type: 'folder', id: 'f1' },
      ]);
      expect(results[0]).to.deep.equal([{ type: 'doc', id: 'd1' }, { type: 'folder', id: 'f1' }, GLOBAL]);
      expect(Object.isFrozen(results[0])).to.equal(true);
      await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
      expect(adapter.ancestorCalls).to.have.length(4);
    });

    it('ctx.attributes: adapter, else resolver, else {}; memoised and frozen; errors reach the model', async () => {
      const adapter = new FakeAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')], scopeAttributes: { 'doc:d1': { a: { b: 1 } } } });
      const resolver = new FakeScopeResolver(['org'], { 'org:o1': null }, { 'org:o1': { policy: 'x' } });
      const got: unknown[] = [];
      const m = new StaticModel('m', {
        vote: async (_req, ctx) => {
          got.push(await ctx.attributes({ type: 'doc', id: 'd1' }));
          got.push(await ctx.attributes({ type: 'doc', id: 'd1' }));
          got.push(await ctx.attributes({ type: 'org', id: 'o1' }));
          got.push(await ctx.attributes({ type: 'team', id: 't1' }));
          return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      await make({ adapters: [adapter], scopeResolvers: [resolver], models: [m] }).check({ principal: alice, permission: 'doc:read' });
      expect(got).to.deep.equal([{ a: { b: 1 } }, { a: { b: 1 } }, { policy: 'x' }, {}]);
      expect(deepFrozen(got[0])).to.equal(true);
      expect(adapter.attributeCalls).to.have.length(1);

      const failing = new FakeScopeResolver(['org'], {});
      failing.attributes = () => Promise.reject(new Error('store down'));
      const asks = new StaticModel('asks', {
        vote: async (_req, ctx) => {
          await ctx.attributes({ type: 'org', id: 'o1' });
          return { model: 'asks', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      const d = await make({ scopeResolvers: [failing], models: [asks] }).check({ principal: alice, permission: 'doc:read' });
      expect(d.reason).to.deep.equal({ code: 'model_error', model: 'asks' });
    });

    it('domain, now, permissions, relation, default conditions', async () => {
      const rel = new FakeRelation('doc', 'owner', () => true);
      let ctx!: EvaluationContext;
      let req!: DecisionRequest;
      const m = new StaticModel('m', {
        vote: (r, c) => {
          ctx = c;
          req = r;
          return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      await make({ relations: [rel], models: [m] }).check({ principal: alice, permission: 'doc:read', env: { ip: '1.2.3.4', now: 'forged' } });
      expect(ctx.domain).to.equal('root');
      expect(ctx.now.toISOString()).to.equal(clock.now.toISOString());
      expect(ctx.permissions).to.equal(REG);
      expect(ctx.relation('doc', 'owner')).to.equal(rel);
      expect(ctx.relation('doc', 'nope')).to.equal(undefined);
      expect(req.env).to.deep.include({ ip: '1.2.3.4' });
      expect((req.env!.now as Date).toISOString()).to.equal(clock.now.toISOString());
      let rejected = false;
      await ctx.conditions.compile({ all: [] }, req, ctx).catch(() => (rejected = true));
      expect(rejected).to.equal(true);
    });
  });

  describe('inputs', () => {
    it('rejects a non-object env, a malformed actor, an invalid clock', async () => {
      const m = new StaticModel('m', { vote: permit() });
      await expectReject(make({ models: [m] }).check({ principal: alice, permission: 'doc:read', env: 'x' as never }), AuthzConfigError);
      await expectReject(make({ models: [m] }).check({ principal: alice, permission: 'doc:read', actor: { type: 'agent' } as never }), AuthzConfigError);
      await expectReject(make({ models: [m], clock: () => new Date('nope') }).check({ principal: alice, permission: 'doc:read' }), AuthzConfigError);
    });

    it("one model moving ctx.now or env.now does not move another's", async () => {
      const seen: string[] = [];
      const a = new StaticModel('a', {
        vote: (req, ctx) => {
          ctx.now.setTime(0);
          (req.env!.now as Date).setTime(0);
          return { model: 'a', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      const b = new StaticModel('b', {
        vote: (req, ctx) => {
          seen.push(ctx.now.toISOString(), (req.env!.now as Date).toISOString());
          return { model: 'b', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      await make({ models: [a, b] }).check({ principal: alice, permission: 'doc:read' });
      expect(seen).to.deep.equal([clock.now.toISOString(), clock.now.toISOString()]);
    });

    it('a native filter in the residual is evaluated against the subject', async () => {
      const row = new FakeRow('doc', 'd1', { size: 3 });
      const adapter = new FakeAdapter(['doc'], { rows: [row] });
      const small = new FakeNativeFilter('native:small', (_args, subject) => ((subject as FakeRow).size as number) < 5);
      const m = new StaticModel('m', { capabilities: { residuals: ['native:small'] }, vote: permit({ op: 'native:small', args: { max: 5 } }) });
      const d = await make({ adapters: [adapter], nativeFilters: [small], models: [m] }).check({ principal: alice, permission: 'doc:read', resource: row });
      expect(d.allowed).to.equal(true);
      expect(small.calls).to.have.length(1);
    });
  });

  describe('trace and explain', () => {
    it('explain attaches the trace (core and model steps, votes, models, durationMs); check does not', async () => {
      const m = new StaticModel('m', {
        vote: (_r, ctx) => {
          ctx.trace({ step: 'grant', note: 'viewer at org', by: 'forged' } as never);
          return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      const a = make({ models: [m, new StaticModel('n')] });
      const d = await a.explain({ principal: alice, permission: 'doc:read' });
      const t = d.trace!;
      expect(t.domain).to.equal('root');
      expect(t.algorithm).to.equal('deny-overrides');
      expect(t.models).to.deep.equal(['m', 'n']);
      expect(t.votes.map((v) => v.model)).to.deep.equal(['m', 'n']);
      expect(t.durationMs).to.be.a('number').and.at.least(0);
      expect(t.steps.some((s) => s.by === 'core')).to.equal(true);
      expect(t.steps.filter((s) => s.by === 'm')).to.deep.equal([{ by: 'm', step: 'grant', note: 'viewer at org' }]);
      expect(t.steps.some((s) => s.by === 'forged')).to.equal(false);
      const plain = await a.check({ principal: alice, permission: 'doc:read' });
      expect(plain).to.not.have.property('trace');
    });

    it('config.explain logs the trace at debug without attaching it', async () => {
      const d = await make({ models: [new StaticModel('m', { vote: permit() })], config: { explain: true } }).check({ principal: alice, permission: 'doc:read' });
      expect(d.trace).to.equal(undefined);
      const debug = log.at('debug');
      expect(debug.length).to.be.greaterThan(0);
      expect(debug.some((e) => e.args.some((x) => x !== null && typeof x === 'object' && 'steps' in (x as object)))).to.equal(true);
    });
  });

  describe('audit', () => {
    it('records denials, not allows', async () => {
      const a = make({ models: [new StaticModel('m', { vote: permit(), applies: (def) => def.name === 'doc:read' })] });
      await a.check({ principal: alice, permission: 'doc:read' });
      await a.check({ principal: alice, permission: 'doc:write', resource: { type: 'doc', id: 'd9' } });
      await tick();
      expect(audit.entries).to.deep.equal([{ kind: 'deny', principal: { type: 'user', id: 'alice' }, permission: 'doc:write', resource: { type: 'doc', id: 'd9' }, reason: 'no_access' }]);
    });

    it('auditDenials: false records nothing for denials', async () => {
      await make({ config: { auditDenials: false } }).check({ principal: alice, permission: 'doc:read' });
      await tick();
      expect(audit.entries).to.have.length(0);
    });

    it('records explain calls with the trace', async () => {
      await make({ models: [new StaticModel('m', { vote: permit() })] }).explain({ principal: alice, permission: 'doc:read' });
      await tick();
      expect(audit.kinds()).to.deep.equal(['explain']);
      expect(audit.entries[0].trace?.models).to.deep.equal(['m']);
    });

    it('a throwing or rejecting audit never breaks the check and is logged', async () => {
      for (const mode of ['throw', 'reject'] as const) {
        audit.mode = mode;
        const d = await make().check({ principal: alice, permission: 'doc:read' });
        expect(d.allowed).to.equal(false);
      }
      await tick();
      expect(log.at('error').length).to.be.at.least(2);
    });
  });

  describe('checkMany, filter, filterNow', () => {
    it('checkMany keeps input order, resolves the resource once and shares the scope', async () => {
      const row = new FakeRow('doc', 'd1');
      const adapter = new FakeAdapter(['doc'], { rows: [row] });
      const subjects: unknown[] = [];
      const m = new StaticModel('m', {
        applies: (def) => def.name !== 'doc:write',
        vote: (req) => {
          subjects.push(req.subject);
          return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      const out = await make({ adapters: [adapter], models: [m] }).checkMany(alice, ['doc:write', 'doc:read'], row);
      expect([...out.keys()]).to.deep.equal(['doc:write', 'doc:read']);
      expect(out.get('doc:write')!.allowed).to.equal(false);
      expect(out.get('doc:read')!.allowed).to.equal(true);
      expect(adapter.refOfCalls).to.have.length(1);
      expect(adapter.ancestorCalls).to.have.length(1);
      expect(subjects).to.deep.equal([row]);
    });

    it('checkMany asks the adapters about the resource once, not once per permission', async () => {
      class Counting extends FakeAdapter {
        accepted = 0;
        accepts(target: unknown): target is FakeRow {
          this.accepted++;
          return super.accepts(target);
        }
      }
      const row = new FakeRow('doc', 'd1');
      const adapter = new Counting(['doc'], { rows: [row] });
      const out = await make({ adapters: [adapter], models: [new StaticModel('m', { vote: permit() })] }).checkMany(alice, ['doc:read', 'doc:write'], row);
      expect([...out.values()].map((d) => d.allowed)).to.deep.equal([true, true]);
      expect(adapter.accepted).to.equal(1);
    });

    it('filter returns the bound residual, FALSE when denied, never a ref', async () => {
      const a = make({ models: [new StaticModel('m', { vote: permit(owner()) })] });
      expect(await a.filter(alice, 'doc:read', 'doc')).to.deep.equal({ op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' });
      const b = make({ models: [new StaticModel('m', { vote: permit() }), new StaticModel('n', { vote: deny() })] });
      expect(await b.filter(alice, 'doc:read', 'doc')).to.equal(FALSE);
      const c = make({ models: [new StaticModel('m', { vote: permit({ op: 'cmp', field: 'team', cmp: 'eq', value: { ref: 'actor.team' } }) })] });
      expect(await c.filter(alice, 'doc:read', 'doc')).to.equal(FALSE);
      const n = make({ models: [new StaticModel('m', { vote: permit({ op: 'not', arg: { op: 'cmp', field: 'team', cmp: 'eq', value: { ref: 'scope.org.x' } } }) })] });
      // A type-level scope ref is missing: the vote is indeterminate (decision 29).
      expect(await n.filter(alice, 'doc:read', 'doc')).to.equal(FALSE);
    });

    it('filterNow answers from sync models', () => {
      const a = make({ models: [new StaticModel('m', { vote: permit(owner()) })] });
      expect(a.filterNow(alice, 'doc:read', 'doc')).to.deep.equal({ op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' });
      expect(() => a.filterNow(alice, 'doc:nope', 'doc')).to.throw(UnknownPermission);
    });

    it('filterNow ⇒ undefined when a model returns a promise, with no unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const guard = (e: unknown) => unhandled.push(e);
      process.on('unhandledRejection', guard);
      try {
        const a = make({ models: [new StaticModel('m', { vote: () => Promise.reject(new Error('io')) })] });
        expect(a.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
        const b = make({ models: [new StaticModel('m', { vote: permit(), async: true })] });
        expect(b.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
        await tick();
        expect(unhandled).to.deep.equal([]);
      } finally {
        process.off('unhandledRejection', guard);
      }
    });

    it("filterNow ⇒ undefined without calling evaluate of a sync: 'never' model", () => {
      const never = new StaticModel('never', { capabilities: { sync: 'never' }, vote: permit() });
      const first = new StaticModel('first', { vote: permit() });
      expect(make({ models: [first, never] }).filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
      expect(never.calls).to.have.length(0);
    });

    describe("sync: 'after-preload' (decision 30)", () => {
      const lazy = () => new StaticModel('lazy', { capabilities: { sync: 'after-preload' }, vote: permit(owner()) });
      const OWNED = { op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' };

      it('filterNow ⇒ undefined before preload, without calling evaluate; the residual after it', async () => {
        const m = lazy();
        const a = make({ models: [m] });
        expect(a.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
        expect(m.calls).to.have.length(0);
        await a.preload(alice);
        // A fresh request scope: the Authorizer remembers the preload.
        expect(a.filterNow(alice, 'doc:read', 'doc', { cache: new Map() })).to.deep.equal(OWNED);
        expect(a.filterNow(alice, 'doc:read', 'doc')).to.deep.equal(OWNED);
      });

      it('the preload is per principal the models run with', async () => {
        const a = make({ models: [lazy()] });
        await a.preload(principal('user', 'bob'));
        expect(a.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
        // Another object with the same state counts as preloaded.
        await a.preload(principal('user', 'alice'));
        expect(a.filterNow(principal('user', 'alice'), 'doc:read', 'doc')).to.deep.equal(OWNED);
        // A principal whose state differs is not.
        expect(a.filterNow(principal('user', 'alice', { attributes: { team: 'x' } }), 'doc:read', 'doc')).to.equal(undefined);
      });

      it('the request scope records the preload too', async () => {
        const a = make({ models: [lazy()] });
        const scope = { cache: new Map<string, unknown>() };
        await a.preload(alice, scope);
        // As if the bounded per-Authorizer record had dropped alice (white-box).
        (a as any)['preloaded'].clear();
        expect(a.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
        expect(a.filterNow(alice, 'doc:read', 'doc', scope)).to.deep.equal(OWNED);
        // An invalidate() makes the scope's record stale too.
        a.invalidate(['*']);
        expect(a.filterNow(alice, 'doc:read', 'doc', scope)).to.equal(undefined);
      });

      it('invalidate() forgets the preloads', async () => {
        const a = make({ models: [lazy()] });
        await a.preload(alice);
        a.invalidate(['subject:user:alice']);
        expect(a.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
      });

      it('a preload that throws or overlaps an invalidate() is not recorded', async () => {
        const m = lazy();
        m.preloadImpl = () => Promise.reject(new Error('down'));
        const a = make({ models: [m] });
        await a.preload(alice);
        expect(a.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);

        const slow = lazy();
        let release!: () => void;
        slow.preloadImpl = () => new Promise<void>((r) => (release = r));
        const b = make({ models: [slow] });
        const pending = b.preload(alice);
        await tick();
        b.invalidate(['*']);
        release();
        await pending;
        expect(b.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
      });

      it('a preload that never settles ends after modelTimeoutMs like a failed one: not recorded, request marked, logged', async () => {
        const m = lazy();
        m.preloadImpl = () => new Promise<void>(() => undefined);
        const a = make({ models: [m], config: { modelTimeoutMs: 50 } });
        const scope = { cache: new Map<string, unknown>() };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([a.preload(alice, scope).then(() => 'settled'), new Promise((r) => (timer = setTimeout(() => r('pending'), 2000)))]);
        clearTimeout(timer);
        expect(outcome).to.equal('settled');
        expect(a.filterNow(alice, 'doc:read', 'doc', scope)).to.equal(undefined);
        expect(a.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
        expect(scope.cache.get(l1Key('fault', 'root', ''))).to.equal(true);
        expect(log.at('error').some((e) => /preload/.test(e.message) && /timed out/.test(e.message))).to.equal(true);
      });

      it('an intersect delegate is gated on its own preload', async () => {
        const bob = principal('user', 'bob');
        const token = principal('token', 't1', { onBehalfOf: bob });
        const a = make({ models: [lazy()] });
        await a.preload(token);
        expect(a.filterNow(token, 'doc:read', 'doc')).to.not.equal(undefined);
        const b = make({ models: [lazy()] });
        await b.preload(principal('token', 't1'));
        expect(b.filterNow(token, 'doc:read', 'doc')).to.equal(undefined);
      });

      it('the async paths are not gated', async () => {
        const a = make({ models: [lazy()] });
        expect(await a.filter(alice, 'doc:read', 'doc')).to.deep.equal(OWNED);
        expect((await a.check({ principal: alice, permission: 'doc:read' })).allowed).to.equal(true);
      });

      it('a model left out of the plan does not gate', () => {
        const other = new StaticModel('other', { capabilities: { sync: 'after-preload' }, applies: () => false, vote: permit() });
        const a = make({ models: [new StaticModel('m', { vote: permit(owner()) }), other] });
        expect(a.filterNow(alice, 'doc:read', 'doc')).to.deep.equal(OWNED);
      });
    });
  });

  describe('decisions', () => {
    it('are deep-frozen; inputs are not mutated', async () => {
      const adapter = new FakeAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')] });
      const m = new StaticModel('m', { vote: () => ({ model: 'm', permitWhen: owner(), denyWhen: FALSE, cacheable: true, roles: { project: 'viewer' }, validUntil: new Date('2027-01-01T00:00:00Z') }) });
      const p = principal('user', 'alice', { attributes: { team: 'x' } });
      const input = { principal: p, permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, env: { ip: '1.1.1.1' } };
      const before = structuredClone(input);
      const d = await make({ adapters: [adapter], models: [m] }).explain(input);
      expect(deepFrozen(d)).to.equal(true);
      expect(input).to.deep.equal(before);
      expect(Object.isFrozen(p)).to.equal(false);
      expect(Object.isFrozen(input.env)).to.equal(false);
      expect(d.roles).to.deep.equal({ project: 'viewer' });
      expect(d.validUntil?.toISOString()).to.equal('2027-01-01T00:00:00.000Z');
    });

    it('every cache hit hands out its own validUntil: one caller changing its Date changes no other', async () => {
      const until = new Date(clock.now.getTime() + 30_000);
      const m = new StaticModel('m', { vote: permit(TRUE, { validUntil: until, cacheable: true }) });
      const a = make({ models: [m], cache: new LruDecisionCache({ clock: clock.clock }) });
      const input = { principal: alice, permission: 'doc:read' };
      const scope = { cache: new Map<string, unknown>() };
      const expected = until.toISOString();

      const fresh = await a.check(input, scope);
      fresh.validUntil!.setTime(Date.parse('2099-01-01T00:00:00Z'));
      const l1 = await a.check(input, scope);
      expect(l1.validUntil!.toISOString()).to.equal(expected);
      l1.validUntil!.setTime(0);
      const l2 = await a.check(input, { cache: new Map() });
      expect(l2.validUntil!.toISOString()).to.equal(expected);
      l2.validUntil!.setTime(0);

      expect((await a.check(input, scope)).validUntil!.toISOString()).to.equal(expected);
      expect((await a.check(input, { cache: new Map() })).validUntil!.toISOString()).to.equal(expected);
      expect(m.calls).to.have.length(1);
      expect(deepFrozen(l1)).to.equal(true);
      expect(deepFrozen(l2)).to.equal(true);
    });

    it('roles merge in model-name order (first wins per ladder), also on denials; validUntil is the earliest valid one', async () => {
      const b = new StaticModel('b', { vote: { roles: { project: 'admin', org: 'owner' }, validUntil: new Date('2027-01-01T00:00:00Z') } });
      const a = new StaticModel('a', { vote: { roles: { project: 'viewer' }, validUntil: new Date('2026-12-01T00:00:00Z') } });
      const c = new StaticModel('c', { vote: { validUntil: new Date('invalid') } });
      const d = await make({ models: [b, a, c] }).check({ principal: alice, permission: 'doc:read' });
      expect(d.allowed).to.equal(false);
      expect(d.roles).to.deep.equal({ project: 'viewer', org: 'owner' });
      expect(d.validUntil?.toISOString()).to.equal('2026-12-01T00:00:00.000Z');
    });

    it('allowed: fields read/write; denied: empty fields, reason only on denial', async () => {
      const ok = await make({ models: [new StaticModel('m', { vote: permit() })] }).check({ principal: alice, permission: 'doc:read' });
      expect(ok.fields.write).to.deep.equal(['*', '!Password']);
      expect(ok).to.not.have.property('reason');
      const no = await make({ models: [new StaticModel('m')] }).check({ principal: alice, permission: 'doc:read' });
      expect(no.fields).to.deep.equal({ read: [], write: [] });
      expect(no.reason?.code).to.equal('no_access');
      expect(no.domain).to.equal('root');
      expect(no.principal).to.deep.equal({ type: 'user', id: 'alice' });
    });

    it('carries the actor ref when there is one', async () => {
      const agent = principal('agent', 'bot');
      const d = await make({ models: [new StaticModel('m', { vote: permit() })] }).check({ principal: alice, actor: agent, permission: 'doc:read' });
      expect(d.actor).to.deep.equal({ type: 'agent', id: 'bot' });
    });

    it('a subject decides a conditional permit (residual TRUE or FALSE)', async () => {
      const row = new FakeRow('doc', 'd1', { owner: 'alice' });
      const other = new FakeRow('doc', 'd2', { owner: 'bob' });
      const adapter = new FakeAdapter(['doc'], { rows: [row, other] });
      const a = make({ adapters: [adapter], models: [new StaticModel('m', { vote: permit(owner()) })] });
      const yes = await a.check({ principal: alice, permission: 'doc:read', resource: row });
      expect(yes.allowed).to.equal(true);
      expect(yes.residual).to.equal(TRUE);
      const no = await a.check({ principal: alice, permission: 'doc:read', resource: other });
      expect(no.allowed).to.equal(false);
      expect(no.residual).to.equal(FALSE);
      expect(no.reason?.code).to.equal('residual_false');
    });

    it('uses the adapter attribute reader for the subject', async () => {
      const row = new FakeRow('doc', 'd1');
      const adapter = new FakeAdapter(['doc'], { rows: [row], attribute: (_s, f) => (f === 'owner' ? 'alice' : undefined) });
      const d = await make({ adapters: [adapter], models: [new StaticModel('m', { vote: permit(owner()) })] }).check({ principal: alice, permission: 'doc:read', resource: row });
      expect(d.allowed).to.equal(true);
    });
  });

  describe('preload and invalidate', () => {
    it('preload calls every model for the principal and its onBehalfOf chain; throws are logged', async () => {
      const m = new StaticModel('m');
      const bad = new StaticModel('bad');
      bad.preloadImpl = () => Promise.reject(new Error('db down'));
      const bob = principal('user', 'bob');
      const agent = principal('agent', 'bot', { onBehalfOf: bob });
      await make({ models: [m, bad] }).preload(agent);
      expect(m.preloads).to.deep.equal([agent, bob]);
      expect(log.at('error').length).to.be.greaterThan(0);
    });

    it('invalidate reaches every model; throws are logged and swallowed', () => {
      const m = new StaticModel('m');
      const bad = new StaticModel('bad');
      bad.invalidateImpl = () => {
        throw new Error('x');
      };
      make({ models: [bad, m] }).invalidate(['role:viewer']);
      expect(m.invalidations).to.deep.equal([['role:viewer']]);
      expect(log.at('error').length).to.be.greaterThan(0);
    });
  });

  it('a vote in the trace is an engine copy; the model object is not frozen', async () => {
    const vote: Vote = { model: 'm', permitWhen: FALSE, denyWhen: FALSE, cacheable: true };
    const d = await make({ models: [new StaticModel('m', { vote: () => vote })] }).explain({ principal: alice, permission: 'doc:read' });
    expect(d.trace!.votes[0]).to.not.equal(vote);
    expect(Object.isFrozen(vote)).to.equal(false);
  });
});

describe('Authorizer: bounded work and termination', () => {
  const atom = (field: string): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value: 1 });
  // and(or(x, a_k), or(x, b_k)) repeated: linear as a DAG, 2^n nodes as a tree.
  const dagFilter = (n: number): ResourceFilter => {
    let x = atom('x');
    for (let k = 0; k < n; k++) x = and(or(x, atom(`a${k}`)), or(x, atom(`b${k}`)));
    return x;
  };
  const dagData = (n: number): Record<string, unknown> => {
    let o: Record<string, unknown> = { leaf: 1 };
    for (let k = 0; k < n; k++) o = { l: o, r: o };
    return o;
  };
  const within = async <T>(ms: number, run: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const out = await run();
    expect(Date.now() - t0, 'elapsed ms').to.be.below(ms);
    return out;
  };

  it('a vote whose residual is a contract-built DAG of depth 30 is indeterminate, fast', async () => {
    const big = dagFilter(30);
    for (const vote of [permit(big), deny(big), { denies: [{ when: big, reason: { code: 'x' } }] }]) {
      const d = await within(500, () => make({ models: [new StaticModel('dag', { vote })] }).check({ principal: alice, permission: 'doc:read' }));
      expect(d.allowed).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'model_error', model: 'dag' });
    }
  });

  it('the node budget is shared by permitWhen, denyWhen and denies', async () => {
    // about 6,000 nodes each: under the budget alone, over it together
    const part = dagFilter(10);
    const ok = await make({ models: [new StaticModel('m', { vote: permit(part) })] }).explain({ principal: alice, permission: 'doc:read' });
    expect(ok.trace!.votes[0].error).to.equal(undefined);
    const d = await make({ models: [new StaticModel('m', { vote: { permitWhen: part, denyWhen: part, denies: [{ when: part, reason: { code: 'x' } }] } })] }).explain({ principal: alice, permission: 'doc:read' });
    expect(d.trace!.votes[0].error).to.match(/nodes/);
  });

  it('a custom combinator returning a DAG denies with model_error, fast', async () => {
    class Dag extends Combinator {
      readonly name = 'dag';
      combine() {
        return { allow: dagFilter(30) };
      }
    }
    const a = make({ combinators: [new Dag()], combine: { default: { algorithm: 'dag' } }, models: [new StaticModel('m', { vote: permit() })] });
    const d = await within(500, () => a.check({ principal: alice, permission: 'doc:read' }));
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'model_error' });
  });

  it('a reason or native args built as a shared-object DAG make the vote indeterminate, fast', async () => {
    const big = dagData(30);
    const viaReason = await within(500, () => make({ models: [new StaticModel('r', { vote: { reason: { code: 'x', big } } })] }).check({ principal: alice, permission: 'doc:read' }));
    expect(viaReason.reason).to.deep.equal({ code: 'model_error', model: 'r' });
    const native: ResourceFilter = { op: 'native:geo', args: big };
    const viaArgs = await within(500, () => make({ models: [new StaticModel('n', { capabilities: { residuals: ['native:geo'] }, vote: permit(native) })] }).check({ principal: alice, permission: 'doc:read' }));
    expect(viaArgs.reason).to.deep.equal({ code: 'model_error', model: 'n' });
  });

  it('ctx.trace with DAG data keeps the step without data', async () => {
    const m = new StaticModel('m', {
      vote: (_r, ctx) => {
        ctx.trace({ step: 'big', note: 'shared data', data: dagData(30) });
        return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
      },
    });
    const d = await within(500, () => make({ models: [m] }).explain({ principal: alice, permission: 'doc:read' }));
    expect(d.trace!.steps.filter((s) => s.by === 'm')).to.deep.equal([{ by: 'm', step: 'big', note: 'shared data' }]);
  });

  it('scope attributes built as a DAG make the asking model indeterminate', async () => {
    const resolver = new FakeScopeResolver(['org'], {});
    resolver.attributes = async () => dagData(30);
    const asks = new StaticModel('asks', {
      vote: async (_req, ctx) => {
        await ctx.attributes({ type: 'org', id: 'o1' });
        return { model: 'asks', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
      },
    });
    const d = await within(500, () => make({ scopeResolvers: [resolver], models: [asks] }).check({ principal: alice, permission: 'doc:read' }));
    expect(d.reason).to.deep.equal({ code: 'model_error', model: 'asks' });
  });

  it('the explain trace carries the whole residual, however deep', async () => {
    let deep: ResourceFilter = atom('x');
    for (let k = 0; k < 40; k++) deep = { op: 'not', arg: { op: 'and', args: [deep, atom(`a${k}`)] } };
    const d = await make({ models: [new StaticModel('m', { vote: permit(deep) })] }).explain({ principal: alice, permission: 'doc:read' });
    const combine = d.trace!.steps.find((s) => s.by === 'core' && s.step === 'combine')!;
    expect((combine.data as { residual: ResourceFilter }).residual).to.deep.equal(d.residual);
  });

  describe('one data budget per vote (shared values are charged per copy)', () => {
    const shared = Array.from({ length: 9000 }, (_, i) => i);
    const caps = { effects: ['permit', 'deny'], residuals: ['native:x'] };
    const timed = <T>(ms: number, run: () => T): T => {
      const t0 = performance.now();
      const out = run();
      expect(performance.now() - t0, 'elapsed ms').to.be.below(ms);
      return out;
    };

    // The re-review probe: one args array referenced by many native nodes.
    for (const n of [500, 2000, 9999]) {
      it(`native args shared by ${n} nodes ⇒ indeterminate, fast`, () => {
        const node = { op: 'native:x', args: shared };
        const v = timed(500, () => sanitizeVote({ permitWhen: { op: 'or', args: Array.from({ length: n }, () => node) }, denyWhen: FALSE, cacheable: true }, 'm', caps));
        expect(v.error).to.match(/values/);
      });

      it(`a reason shared by ${n} denies ⇒ indeterminate, fast`, () => {
        const reason = { code: 'x', data: shared };
        const v = timed(500, () => sanitizeVote({ permitWhen: FALSE, denyWhen: TRUE, denies: Array.from({ length: n }, () => ({ when: TRUE, reason })), cacheable: true }, 'm', caps));
        expect(v.error).to.match(/values/);
      });
    }

    it('the budget is shared by native args, reasons, roles, fields and the vote trace', () => {
      const part = Array.from({ length: 4000 }, (_, i) => i);
      const ok = sanitizeVote({ permitWhen: { op: 'native:x', args: part }, denyWhen: FALSE, cacheable: true }, 'm', caps);
      expect(ok.error).to.equal(undefined);
      const fields = Array.from({ length: 4000 }, (_, i) => `f${i}`);
      const over = sanitizeVote({ permitWhen: { op: 'native:x', args: part }, denyWhen: FALSE, reason: { code: 'x', part }, fields: { read: fields }, cacheable: true }, 'm', caps);
      expect(over.error).to.match(/values/);
    });

    it('a small vote stays valid', () => {
      const v = sanitizeVote({ permitWhen: { op: 'native:x', args: { k: [1, 2, 3] } }, denyWhen: FALSE, reason: { code: 'x', n: 1 }, roles: { project: 'viewer' }, fields: { read: ['a'] }, cacheable: true }, 'm', caps);
      expect(v.error).to.equal(undefined);
    });

    it('a check whose vote shares native args across many nodes denies fast', async () => {
      const node: ResourceFilter = { op: 'native:x', args: shared };
      const m = new StaticModel('m', { capabilities: { residuals: ['native:x'] }, vote: permit({ op: 'or', args: Array.from({ length: 9999 }, () => node) }) });
      const t0 = Date.now();
      const d = await make({ models: [m] }).check({ principal: alice, permission: 'doc:read' });
      expect(Date.now() - t0).to.be.below(5000);
      expect(d.reason).to.deep.equal({ code: 'model_error', model: 'm' });
    });

    it('ctx.trace charges one budget per model per check', async () => {
      const m = new StaticModel('m', {
        vote: (_r, ctx) => {
          for (let i = 0; i < 10_000; i++) ctx.trace({ step: 's', note: 'n', data: shared });
          return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      const t0 = Date.now();
      const d = await make({ models: [m] }).explain({ principal: alice, permission: 'doc:read' });
      expect(Date.now() - t0).to.be.below(5000);
      expect(d.allowed).to.equal(true);
      const steps = d.trace!.steps.filter((x) => x.by === 'm');
      expect(steps.length).to.be.at.most(1000);
      expect(steps.filter((x) => x.data !== undefined).length).to.equal(1);
    });
  });

  it('preload terminates on self or cyclic delegation through system/unattended principals and preloads nothing a check would throw for', async () => {
    type Mutable = { -readonly [K in keyof Principal]: Principal[K] };
    const m = new StaticModel('m');
    const self: Mutable = principal('system', 'fake');
    self.onBehalfOf = self;
    const s2: Mutable = principal('system', 's');
    const u2: Mutable = principal('unattended', 'u', { onBehalfOf: s2 });
    s2.onBehalfOf = u2;
    const user: Mutable = principal('user', 'loop');
    user.onBehalfOf = user;
    const a = make({ models: [m] });
    await within(500, () => a.preload(self));
    await within(500, () => a.preload(s2));
    await within(500, () => a.preload(user));
    expect(m.preloads).to.deep.equal([]);
  });

  it('a fire-and-forget ctx.check past the depth limit is not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const guard = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', guard);
    try {
      // Each level starts a nested check without awaiting it; level 8's is refused.
      const leaf = new StaticModel('leaf', {
        vote: (req, ctx) => {
          void ctx.check({ principal: req.principal, permission: req.permission, resource: req.resource });
          return { model: 'leaf', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        },
      });
      await make({ models: [leaf] }).check({ principal: alice, permission: 'doc:read' });
      for (let i = 0; i < 10 && leaf.calls.length < 9; i++) await tick();
      await tick();
      expect(leaf.calls).to.have.length(9);
      expect(unhandled).to.deep.equal([]);
    } finally {
      process.off('unhandledRejection', guard);
    }
  });

  it('a sparse or malformed ancestors list fails closed', async () => {
    // eslint-disable-next-line no-sparse-arrays
    for (const answer of [[, { type: 'doc', id: 'x' }], [{ type: 'doc', id: 'x' }, undefined], 'nope']) {
      const adapter = new FakeAdapter(['doc']);
      adapter.ancestors = async () => answer as never;
      await expectReject(make({ adapters: [adapter], models: [new StaticModel('m', { vote: permit() })] }).check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'x' } }), AuthzConfigError);
    }
  });

  it('non-finite cmp literals make the vote indeterminate', async () => {
    for (const value of [Number.NaN, Infinity, -Infinity, [1, Number.NaN], [Infinity]]) {
      const m = new StaticModel('m', { vote: permit({ op: 'cmp', field: 'a', cmp: 'eq', value } as ResourceFilter) });
      const d = await make({ models: [m] }).check({ principal: alice, permission: 'doc:read' });
      expect(d.reason, String(value)).to.deep.equal({ code: 'model_error', model: 'm' });
    }
  });

  it('the principal gate reads type and id once', async () => {
    let reads = 0;
    const shifty = {
      id: 'x',
      authenticated: true,
      source: 'session',
      attributes: {},
      get type() {
        return reads++ === 0 ? 'user' : 'system';
      },
    };
    const d = await make({ models: [new StaticModel('m', { vote: permit() })] }).check({ principal: shifty as Principal, permission: 'doc:read' });
    expect(d.principal).to.deep.equal({ type: 'user', id: 'x' });
  });

  it('subject evaluation is bounded by modelTimeoutMs and denies on timeout', async () => {
    const row = new FakeRow('doc', 'd1');
    const adapter = new FakeAdapter(['doc'], { rows: [row] });
    const hangs = new FakeRelation('doc', 'owner', () => new Promise<boolean>(() => undefined));
    const m = new StaticModel('m', { vote: permit({ op: 'relation', relation: 'owner' }) });
    const d = await within(500, () => make({ adapters: [adapter], relations: [hangs], models: [m], config: { modelTimeoutMs: 20 } }).check({ principal: alice, permission: 'doc:read', resource: row }));
    expect(d.allowed).to.equal(false);
    expect(d.residual).to.equal(FALSE);
    expect(d.reason).to.deep.equal({ code: 'model_error' });
    expect(log.at('error').some((e) => /subject/.test(e.message))).to.equal(true);
  });
});

describe('Authorizer: an intersect delegate checked with a subject narrows to the filter (B06)', () => {
  const bob = principal('user', 'bob');
  const agent = principal('token', 't1', { onBehalfOf: bob });
  const ownerOp: ResourceFilter = { op: 'relation', relation: 'owner' };
  const team = (value: string): ResourceFilter => ({ op: 'cmp', field: 'team', cmp: 'eq', value });
  const underF1: ResourceFilter = { op: 'under', scopes: [{ type: 'folder', id: 'f1' }] };
  const d1 = new FakeRow('doc', 'd1', { owner: 'bob', team: 'red' });
  const d2 = new FakeRow('doc', 'd2', { owner: 'carol', team: 'blue' });
  const d3 = new FakeRow('doc', 'd3', { owner: 'carol', team: 'red' });
  const d4 = new FakeRow('doc', 'd4', { owner: 'bob', team: 'red' }, { type: 'folder', id: 'f1' });
  const RESIDUALS = [...CORE_FILTER_OPS, 'native:owns'] as const;
  const byId = (grants: Readonly<Record<string, ResourceFilter>>, own?: (req: DecisionRequest, ctx: EvaluationContext) => void) =>
    new StaticModel('m', {
      capabilities: { residuals: RESIDUALS },
      vote: (req: DecisionRequest, ctx: EvaluationContext): Vote => {
        own?.(req, ctx);
        return { model: 'm', permitWhen: grants[req.principal.id] ?? FALSE, denyWhen: FALSE, cacheable: true };
      },
    });
  const setup = (m: StaticModel, options: Partial<AuthorizerOptions> = {}) => {
    const adapter = new FakeAdapter(['doc', 'folder'], { rows: [new FakeRow('folder', 'f1'), d1, d2, d3, d4], relations: [new FakeRelation('doc', 'owner', (p, _ref, subject) => (subject as FakeRow).owner === p.id)] });
    return make({ adapters: [adapter], models: [m], ...options });
  };
  const delegateDenial = { code: 'delegate', priority: 200, delegate: 'user:bob' };

  it('a relation the delegate holds on the row is stripped from the filter, so the check denies the row too (delegate)', async () => {
    const a = setup(byId({ t1: TRUE, bob: ownerOp }));
    expect((await a.check({ principal: bob, permission: 'doc:read', resource: d1 })).allowed).to.equal(true);
    expect(await a.filter(agent, 'doc:read', 'doc')).to.deep.equal(FALSE);
    const d = await a.check({ principal: agent, permission: 'doc:read', resource: d1 });
    expect(d.allowed).to.equal(false);
    expect(d.residual).to.equal(FALSE);
    expect(d.reason).to.deep.equal(delegateDenial);
    const explained = await a.explain({ principal: agent, permission: 'doc:read', resource: d1 });
    expect(explained.trace!.steps.some((s) => s.by === 'core' && s.step === 'delegation' && /type-level residual/.test(s.note))).to.equal(true);
  });

  it('a native filter that holds for the delegate on the row is stripped the same way', async () => {
    const owns = new FakeNativeFilter('native:owns', (args, subject) => (subject as FakeRow).owner === (args as { who: string }).who);
    const a = setup(byId({ t1: TRUE, bob: { op: 'native:owns', args: { who: 'bob' } } }), { nativeFilters: [owns] });
    expect((await a.check({ principal: bob, permission: 'doc:read', resource: d1 })).allowed).to.equal(true);
    expect(await a.filter(agent, 'doc:read', 'doc')).to.deep.equal(FALSE);
    const d = await a.check({ principal: agent, permission: 'doc:read', resource: d1 });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal(delegateDenial);
  });

  it('a `not relation` (FALSE once stripped) leaves the rows where the cmp parts hold', async () => {
    const a = setup(byId({ t1: TRUE, bob: or(team('red'), not(ownerOp)) }));
    expect(await a.filter(agent, 'doc:read', 'doc')).to.deep.equal(team('red'));
    expect((await a.check({ principal: agent, permission: 'doc:read', resource: d1 })).allowed).to.equal(true);
    expect((await a.check({ principal: agent, permission: 'doc:read', resource: d3 })).allowed).to.equal(true);
    // bob does not own d2, so his own check allows it; the filter leaves it out.
    expect((await a.check({ principal: bob, permission: 'doc:read', resource: d2 })).allowed).to.equal(true);
    const d = await a.check({ principal: agent, permission: 'doc:read', resource: d2 });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal(delegateDenial);
  });

  it('a delegate with the run-as principal key is evaluated exactly, with no type-level check', async () => {
    const self = principal('user', 'carol', { onBehalfOf: principal('user', 'carol') });
    const m = byId({ carol: ownerOp });
    const a = setup(m);
    expect(await a.filter(self, 'doc:read', 'doc')).to.deep.equal(ownerOp);
    m.calls.length = 0;
    expect((await a.check({ principal: self, permission: 'doc:read', resource: d2 })).allowed).to.equal(true);
    expect(m.calls).to.have.length(2);
    expect((await a.check({ principal: self, permission: 'doc:read', resource: d1 })).allowed).to.equal(false);
  });

  it('a strip evaluation that times out is an engine fault: denied, logged, and the memos of the decision dropped', async () => {
    const ancestorsKey = l1Key('ancestors', 'root', resourceKey({ type: 'doc', id: 'd4' }));
    const run = async (hang: boolean) => {
      const scope = { cache: new Map<string, unknown>() };
      let loads = 0;
      let armed = hang;
      const m = byId({ t1: TRUE, bob: or(ownerOp, underF1) }, (req, ctx) => {
        if (req.principal.id !== 't1') return;
        if (!ctx.cache.has('roles')) {
          loads++;
          ctx.cache.set('roles', true);
        }
        // After the models only the strip evaluation reads the row's ancestors.
        if (armed) scope.cache.set(ancestorsKey, new Promise(() => undefined));
      });
      const a = setup(m, { config: { modelTimeoutMs: 30 } });
      const first = await a.check({ principal: agent, permission: 'doc:read', resource: d4 }, scope);
      armed = false;
      scope.cache.delete(ancestorsKey);
      const second = await a.check({ principal: agent, permission: 'doc:read', resource: d4 }, scope);
      return { first, second, loads };
    };
    const ok = await run(false);
    expect(ok.first.allowed).to.equal(true);
    expect(ok.loads).to.equal(1);
    expect(log.at('error')).to.have.length(0);

    const hung = await run(true);
    expect(hung.first.allowed).to.equal(false);
    expect(hung.first.reason).to.deep.equal(delegateDenial);
    expect(log.at('error').some((e) => /type-level residual/.test(e.message) && /timed out/.test(e.message))).to.equal(true);
    // A faulted top-level decision detaches its models' memos.
    expect(hung.second.allowed).to.equal(true);
    expect(hung.loads).to.equal(2);
  });

  it('a throwing attribute read in the strip evaluation is UNKNOWN, as in every subject evaluation: denied delegate', async () => {
    let reads = 0;
    const attribute = (subject: unknown, field: string) => {
      if (field === 'team' && reads++ > 0) throw new Error('column gone');
      return (subject as FakeRow)[field];
    };
    const adapter = new FakeAdapter(['doc', 'folder'], { rows: [d1], attribute, relations: [new FakeRelation('doc', 'owner', (p, _ref, subject) => (subject as FakeRow).owner === p.id)] });
    const a = make({ adapters: [adapter], models: [byId({ t1: TRUE, bob: and(team('red'), or(ownerOp, team('red'))) })] });
    const d = await a.check({ principal: agent, permission: 'doc:read', resource: d1 });
    expect(reads).to.be.at.least(2);
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal(delegateDenial);
  });
});

async function expectReject(p: Promise<unknown>, type: new (...args: never[]) => Error): Promise<void> {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  expect(error, 'expected a rejection').to.be.instanceOf(type);
}
