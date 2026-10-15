import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { AuthzConfigError, SYSTEM, UNATTENDED, UnknownPermission } from '../../src/index.js';
import type { ListPlanRequest, ModelListPlan, PlanTerm } from '../../src/index.js';
import { ListModel, RecordingLog, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const REG = registryOf([
  { name: 'doc:read', types: ['doc', 'folder'], list: true },
  { name: 'doc:write', types: ['doc'] },
]);

const alice = principal('user', 'alice');
const term = (op: string, args: unknown = {}): PlanTerm => ({ op, args });

let log: RecordingLog;
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  log = new RecordingLog();
  clock = fakeClock();
});

const make = (models: ListModel[], options: Partial<AuthorizerOptions> = {}): Authorizer => new Authorizer({ domain: 'root', models, registry: REG, clock: clock.clock, log, ...options });
const planner = (name: string, plan: ModelListPlan | ((req: ListPlanRequest) => unknown)): ListModel => new ListModel(name, { listPlan: plan });

async function rejectsWith(p: Promise<unknown>, type: abstract new (...args: never[]) => Error, pattern?: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).to.be.instanceOf(type);
  if (pattern) expect((caught as Error).message).to.match(pattern);
}

describe('Authorizer.accessPlan', () => {
  describe('refusals', () => {
    it('throws UnknownPermission for an unregistered permission', async () => {
      await rejectsWith(make([]).accessPlan(alice, 'doc:delete', 'doc'), UnknownPermission);
    });

    it('throws AuthzConfigError for a permission not declared list: true', async () => {
      await rejectsWith(make([]).accessPlan(alice, 'doc:write', 'doc'), AuthzConfigError, /list: true/);
    });

    it('throws AuthzConfigError for a type outside the permission types, $global included', async () => {
      await rejectsWith(make([]).accessPlan(alice, 'doc:read', 'task'), AuthzConfigError, /not in its types/);
      await rejectsWith(make([]).accessPlan(alice, 'doc:read', '$global'), AuthzConfigError, /not in its types/);
    });

    it('throws AuthzConfigError when a routed model cannot plan the permission', async () => {
      await rejectsWith(make([new ListModel('m', { listSupport: { reason: 'reads rows' } })]).accessPlan(alice, 'doc:read', 'doc'), AuthzConfigError, /model "m" cannot plan lists of doc:read on "doc"/);
    });

    it('throws AuthzConfigError when the type is routed with another algorithm than deny-overrides', async () => {
      const a = make([planner('m', { kind: 'all' })], { combine: { default: { algorithm: 'deny-overrides' }, types: { doc: { algorithm: 'permit-overrides' } } } });
      await rejectsWith(a.accessPlan(alice, 'doc:read', 'doc'), AuthzConfigError, /deny-overrides only/);
    });
  });

  describe('principal gate and delegation', () => {
    it('SYSTEM gets an unfiltered plan without asking a model', async () => {
      const m = planner('m', { kind: 'deny-all', reason: { code: 'x' } });
      expect(await make([m]).accessPlan(SYSTEM, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [] });
      expect(m.planCalls).to.have.length(0);
    });

    it('UNATTENDED gets none with unattended', async () => {
      const m = planner('m', { kind: 'all' });
      expect(await make([m]).accessPlan(UNATTENDED, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'unattended' } });
      expect(m.planCalls).to.have.length(0);
    });

    it('an anonymous principal is planned for like any other', async () => {
      const m = planner('m', { kind: 'all' });
      expect(await make([m]).accessPlan(principal('anonymous', 'anonymous', { authenticated: false }), 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [] });
      expect(m.planCalls[0].req.principal.type).to.equal('anonymous');
    });

    it('an intersect delegate gets none with delegate, since plans cannot be ANDed', async () => {
      const m = planner('m', { kind: 'all' });
      const agent = principal('agent', 'bot', { onBehalfOf: alice });
      expect(await make([m]).accessPlan(agent, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'delegate', priority: 200, delegate: 'user:alice' } });
      expect(m.planCalls).to.have.length(0);
    });

    it('under inherit the models plan for the delegate', async () => {
      const m = planner('m', (req) => ({ kind: 'terms', permit: [term('owner', { id: req.principal.id })], deny: [] }));
      const agent = principal('agent', 'bot', { onBehalfOf: alice, delegation: 'inherit' });
      expect(await make([m]).accessPlan(agent, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: [term('owner', { id: 'alice' })], deny: [] });
      expect(m.planCalls[0].req.principal.type).to.equal('user');
    });

    it('under inherit the agent is the request actor; without delegation there is none', async () => {
      const m = planner('m', { kind: 'all' });
      const a = make([m]);
      await a.accessPlan(principal('agent', 'bot', { onBehalfOf: alice, delegation: 'inherit' }), 'doc:read', 'doc');
      expect(m.planCalls[0].req.actor?.type).to.equal('agent');
      expect(m.planCalls[0].req.actor?.id).to.equal('bot');
      await a.accessPlan(alice, 'doc:read', 'doc');
      expect(m.planCalls[1].req.actor).to.equal(undefined);
    });
  });

  describe('env', () => {
    it('passes the caller env as check() does: a frozen copy whose now is the engine instant', async () => {
      const m = planner('m', { kind: 'all' });
      const env = { ip: '10.0.0.1', now: new Date('1999-01-01T00:00:00.000Z') };
      await make([m]).accessPlan(alice, 'doc:read', 'doc', env);
      const seen = m.planCalls[0].req.env!;
      expect(seen.ip).to.equal('10.0.0.1');
      expect((seen.now as Date).toISOString()).to.equal('2026-10-01T12:00:00.000Z');
      expect(Object.isFrozen(seen)).to.equal(true);
      expect(seen).to.not.equal(env);
    });

    it('gives an env with only now when the caller passes none, and is not memoised when the caller passes one', async () => {
      const m = planner('m', { kind: 'all' });
      const a = make([m]);
      const scope = { cache: new Map<string, unknown>() };
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      expect(Object.keys(m.planCalls[0].req.env!)).to.deep.equal(['now']);
      await a.accessPlan(alice, 'doc:read', 'doc', { ip: '10.0.0.1' }, scope);
      await a.accessPlan(alice, 'doc:read', 'doc', { ip: '10.0.0.2' }, scope);
      expect(m.planCalls).to.have.length(3);
    });
  });

  describe('combination', () => {
    it('is none with no_access when no model is routed for the permission', async () => {
      expect(await make([]).accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
      const elsewhere = new ListModel('m', { applies: () => false, listPlan: { kind: 'all' } });
      expect(await make([elsewhere]).accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
      expect(elsewhere.planCalls).to.have.length(0);
    });

    it('concatenates the models terms in route order, and a deny-all wins', async () => {
      const a = make([planner('rbac', { kind: 'terms', permit: [term('rbac.assignment')], deny: [term('rbac.deny')] }), planner('owner', { kind: 'terms', permit: [term('relation.column')], deny: [] })]);
      expect(await a.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: [term('rbac.assignment'), term('relation.column')], deny: [term('rbac.deny')] });
      const b = make([planner('rbac', { kind: 'all' }), planner('abac', { kind: 'deny-all', reason: { code: 'mfa_required' } })]);
      expect(await b.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'mfa_required', model: 'abac' } });
    });

    it('skips a model that does not serve the principal type', async () => {
      const svc = new ListModel('svc', { capabilities: { principalTypes: ['service'] }, listPlan: { kind: 'all' } });
      expect(await make([svc]).accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
      expect(svc.planCalls).to.have.length(0);
    });

    it('passes the permission, the type and an evaluation context of the domain', async () => {
      const m = planner('m', { kind: 'all' });
      await make([m]).accessPlan(alice, 'doc:read', 'folder');
      const { req, ctx } = m.planCalls[0];
      expect(req.permission.name).to.equal('doc:read');
      expect(req.type).to.equal('folder');
      expect(ctx.domain).to.equal('root');
      expect(ctx.now.toISOString()).to.equal('2026-10-01T12:00:00.000Z');
    });
  });

  describe('ceilings', () => {
    it('a ceiling whose permissions miss the permission is none with its reason, and no model is asked', async () => {
      const m = planner('m', { kind: 'all' });
      const p = principal('user', 'alice', { ceiling: { permissions: ['doc:write'], reason: 'token_scope' } });
      expect(await make([m]).accessPlan(p, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'token_scope', priority: 200 } });
      expect(m.planCalls).to.have.length(0);
    });

    it('resource ceilings become within; a type-wide one restricts nothing; an empty one covers nothing', async () => {
      const a = make([planner('m', { kind: 'all' })]);
      const f1 = { type: 'folder', id: 'f1' };
      expect(await a.accessPlan(principal('user', 'alice', { ceiling: { resources: [f1] } }), 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], within: [f1] });
      expect(await a.accessPlan(principal('user', 'alice', { ceiling: { resources: [{ type: 'doc' }] } }), 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [] });
      expect(await a.accessPlan(principal('user', 'alice', { ceiling: { resources: [] } }), 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'ceiling', priority: 200 } });
    });

    it('an expired ceiling is none with ceiling', async () => {
      const m = planner('m', { kind: 'all' });
      const p = principal('user', 'alice', { ceiling: { expiresAt: new Date('2026-10-01T11:00:00.000Z') } });
      expect(await make([m]).accessPlan(p, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'ceiling', priority: 200 } });
      expect(m.planCalls).to.have.length(0);
    });

    it('validUntil is the earliest of the ceiling expiry and the models', async () => {
      const p = principal('user', 'alice', { ceiling: { expiresAt: new Date('2026-10-01T14:00:00.000Z') } });
      const sooner = make([planner('m', { kind: 'all', validUntil: new Date('2026-10-01T13:00:00.000Z') })]);
      expect(await sooner.accessPlan(p, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], validUntil: new Date('2026-10-01T13:00:00.000Z') });
      const later = make([planner('m', { kind: 'all', validUntil: new Date('2026-10-01T15:00:00.000Z') })]);
      expect(await later.accessPlan(p, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], validUntil: new Date('2026-10-01T14:00:00.000Z') });
    });

    it('two resource ceilings of one inherit chain are none with ceiling (one within list cannot intersect them)', async () => {
      const delegate = principal('user', 'alice', { ceiling: { resources: [{ type: 'folder', id: 'f2' }] } });
      const agent = principal('agent', 'bot', { onBehalfOf: delegate, delegation: 'inherit', ceiling: { resources: [{ type: 'folder', id: 'f1' }] } });
      expect(await make([planner('m', { kind: 'all' })]).accessPlan(agent, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'ceiling', priority: 200 } });
    });
  });

  describe('faults', () => {
    for (const [what, plan] of [
      ['rejects', () => Promise.reject(new Error('store down'))],
      ['returns a malformed plan', () => ({ kind: 'terms', permit: 'everything', deny: [] })],
      ['returns nothing', () => undefined],
    ] as const) {
      it(`a model that ${what} makes the plan none with model_error, logged`, async () => {
        const a = make([planner('ok', { kind: 'all' }), planner('m', plan)]);
        expect(await a.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'model_error', model: 'm' } });
        expect(
          log
            .at('error')
            .map((e) => e.message)
            .join('\n'),
        ).to.match(/model "m" failed to plan doc:read on "doc"/);
      });
    }

    it('a model past modelTimeoutMs makes the plan none with model_error', async () => {
      const slow = planner('slow', () => new Promise((resolve) => setTimeout(() => resolve({ kind: 'all' }), 50)));
      expect(await make([slow], { config: { modelTimeoutMs: 20 } }).accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'model_error', model: 'slow' } });
    });

    it('a deny-all reason with a lower priority than model_error still wins', async () => {
      const a = make([planner('a', { kind: 'deny-all', reason: { code: 'blocked', priority: 100 } }), planner('m', () => Promise.reject(new Error('down')))]);
      expect(await a.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'blocked', priority: 100, model: 'a' } });
    });
  });

  describe('memo', () => {
    it('is memoised per request scope and type, and dropped by invalidate()', async () => {
      const m = planner('m', { kind: 'all' });
      const a = make([m]);
      const scope = { cache: new Map<string, unknown>() };
      const first = await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      expect(await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope)).to.equal(first);
      expect(m.planCalls).to.have.length(1);
      await a.accessPlan(alice, 'doc:read', 'folder', undefined, scope);
      expect(m.planCalls).to.have.length(2);
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, { cache: new Map() });
      expect(m.planCalls).to.have.length(3);
      a.invalidate(['*']);
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      expect(m.planCalls).to.have.length(4);
    });

    it('a faulted plan is not memoised', async () => {
      const m = planner('m', () => Promise.reject(new Error('store down')));
      const a = make([m]);
      const scope = { cache: new Map<string, unknown>() };
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      expect(m.planCalls).to.have.length(2);
    });
  });
});
