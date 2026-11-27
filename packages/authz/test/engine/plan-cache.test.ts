import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import { FALSE, SYSTEM, TRUE } from '../../src/index.js';
import type { AccessPlan, AccessPlanCache, EvaluationContext, ListPlanRequest, PermissionDef, ResourceRef, ResourceType, Vote } from '../../src/index.js';
import { FakeAdapter, ListModel, RecordingLog, fakeClock, principal, registryOf } from './fakes.js';
import type { ListModelOptions } from './fakes.js';

const expect = chai.expect;

const REG = registryOf([
  { name: 'doc:read', types: ['doc'], list: true },
  { name: 'doc:audit', types: ['doc'], list: true, consistency: 'fresh' },
  { name: 'doc:other', types: ['doc'], list: true },
  { name: 'doc:write', types: ['doc'] },
]);

const alice = principal('user', 'alice');

/** A model whose plans rest on announced state only. */
class KeptModel extends ListModel {
  readonly asked: string[] = [];

  listPlanCacheable(permission: PermissionDef, type: ResourceType): boolean {
    this.asked.push(`${permission.name} on ${type}`);
    return true;
  }
}

class ThrowingModel extends ListModel {
  listPlanCacheable(): boolean {
    throw new Error('broken');
  }
}

class VersionedModel extends KeptModel {
  current = 'v1';

  version(): string {
    return this.current;
  }
}

class BrokenAdapter extends FakeAdapter {
  override ancestors(): Promise<readonly ResourceRef[] | null> {
    return Promise.reject(new Error('db down'));
  }
}

let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  clock = fakeClock();
});

const make = (models: ListModel[]): Authorizer => new Authorizer({ domain: 'root', models, registry: REG, clock: clock.clock, log: new RecordingLog() });
const kept = (name: string, plan: ListModelOptions['listPlan'], options: ListModelOptions = {}): KeptModel => new KeptModel(name, { ...options, listPlan: plan });

function cacheOf(plan: AccessPlan): AccessPlanCache {
  if (plan.cache === undefined) throw new Error(`no cache on ${JSON.stringify(plan)}`);
  return plan.cache;
}

const planOnNestedWrite = async (_req: unknown, ctx: EvaluationContext) => ((await ctx.check({ principal: alice, permission: 'doc:write', resource: { type: 'doc', id: 'd1' } })).allowed ? { kind: 'all' } : { kind: 'abstain' });

/** A plan resting on a nested check of doc:write on d1, whose vote is cacheable or not. */
const nestedChecker = (cacheable: boolean, vote: Partial<Vote> = {}): KeptModel => new KeptModel('n', { vote: { permitWhen: TRUE, cacheable, ...vote }, listPlan: planOnNestedWrite });

describe('Authorizer.accessPlan: a plan kept beyond its request', () => {
  it('carries the tags of a type-level decision of the principal, a key and the decision ttl when every model says so', async () => {
    const a = kept('a', { kind: 'terms', permit: [{ op: 'x', args: {} }], deny: [] });
    const b = kept('b', { kind: 'abstain' });
    const cache = cacheOf(await make([a, b]).accessPlan(alice, 'doc:read', 'doc'));

    expect(cache.tags).to.deep.equal(['*', 'model:a', 'model:b', 'scope:*', 'subject:user:alice']);
    expect(cache.ttlMs).to.equal(60_000);
    expect(a.asked).to.deep.equal(['doc:read on doc']);
  });

  it('keys by the whole principal state: alike for the same state, apart for another principal or other attributes', async () => {
    const keyOf = async (who: Parameters<Authorizer['accessPlan']>[0]) => cacheOf(await make([kept('a', { kind: 'all' })]).accessPlan(who, 'doc:read', 'doc')).key;
    const first = await keyOf(alice);

    expect(await keyOf(principal('user', 'alice'))).to.equal(first);
    expect(new Set([first, await keyOf(principal('user', 'bob')), await keyOf(principal('user', 'alice', { attributes: { dept: 'x' } }))]).size).to.equal(3);
  });

  it('is capped by validUntil, and absent once validUntil has passed', async () => {
    const soon = new Date(clock.now.getTime() + 10_000);
    const past = new Date(clock.now.getTime() - 1);

    expect(cacheOf(await make([kept('a', { kind: 'all', validUntil: soon })]).accessPlan(alice, 'doc:read', 'doc')).ttlMs).to.equal(10_000);
    expect((await make([kept('a', { kind: 'all', validUntil: past })]).accessPlan(alice, 'doc:read', 'doc')).cache).to.equal(undefined);
  });

  it('keeps a none plan of models that say so', async () => {
    const plan = await make([kept('a', { kind: 'deny-all', reason: { code: 'role_denied' } })]).accessPlan(alice, 'doc:read', 'doc');

    expect(plan.kind).to.equal('none');
    expect(cacheOf(plan).tags).to.deep.equal(['*', 'model:a', 'scope:*', 'subject:user:alice']);
  });

  it('keeps nothing when one model does not say so, or throws while answering', async () => {
    expect((await make([kept('a', { kind: 'all' }), new ListModel('s', { listPlan: { kind: 'all' } })]).accessPlan(alice, 'doc:read', 'doc')).cache).to.equal(undefined);
    expect((await make([new ThrowingModel('t', { listPlan: { kind: 'all' } })]).accessPlan(alice, 'doc:read', 'doc')).cache).to.equal(undefined);
  });

  it('keeps nothing when no model planned', async () => {
    const plan = await make([kept('a', { kind: 'all' }, { capabilities: { principalTypes: ['service'] } })]).accessPlan(alice, 'doc:read', 'doc');

    expect([plan.kind, plan.cache]).to.deep.equal(['none', undefined]);
  });

  it('keeps nothing for a call with an env, a fresh permission, SYSTEM or a failed model', async () => {
    const a = make([kept('a', { kind: 'all' })]);
    const failed = await make([new KeptModel('f', { listPlan: () => Promise.reject(new Error('down')) })]).accessPlan(alice, 'doc:read', 'doc');

    expect((await a.accessPlan(alice, 'doc:read', 'doc', { ip: '10.0.0.1' })).cache).to.equal(undefined);
    expect((await a.accessPlan(alice, 'doc:audit', 'doc')).cache).to.equal(undefined);
    expect((await a.accessPlan(SYSTEM, 'doc:read', 'doc')).cache).to.equal(undefined);
    expect([failed.kind, failed.cache]).to.deep.equal(['none', undefined]);
  });

  it('adds the tags of a nested check the plan rested on, and keeps nothing when that check could not be cached', async () => {
    const tags = cacheOf(await make([nestedChecker(true)]).accessPlan(alice, 'doc:read', 'doc')).tags;

    expect(tags).to.include.members(['scope:doc:d1', 'scope:*', 'subject:user:alice']);
    expect((await make([nestedChecker(false)]).accessPlan(alice, 'doc:read', 'doc')).cache).to.equal(undefined);
  });

  it('lives no longer than the grant behind a nested check it rested on', async () => {
    const plan = await make([nestedChecker(true, { validUntil: new Date(clock.now.getTime() + 5_000) })]).accessPlan(alice, 'doc:read', 'doc');

    expect(cacheOf(plan).ttlMs).to.equal(5_000);
    expect(cacheOf(await make([nestedChecker(true)]).accessPlan(alice, 'doc:read', 'doc')).ttlMs).to.equal(60_000);
  });

  it('shows the nested bound in validUntil, so the request memo ends with the grant too', async () => {
    const expiry = new Date(clock.now.getTime() + 5_000);
    const live = (): Vote => (clock.now.getTime() < expiry.getTime() ? { model: 'n', permitWhen: TRUE, denyWhen: FALSE, cacheable: true, validUntil: expiry } : { model: 'n', permitWhen: FALSE, denyWhen: FALSE, cacheable: true });
    const a = make([new KeptModel('n', { vote: live, listPlan: planOnNestedWrite })]);
    const scope = { cache: new Map<string, unknown>() };
    const first = await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);

    expect(first.kind === 'filter' ? first.validUntil?.getTime() : undefined).to.equal(expiry.getTime());
    clock.advance(6_000);
    expect((await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope)).kind).to.equal('none');
  });

  it('a plan that read a memoised nested answer while the nested check still ran ends with its grant (review SX36B-RV-F2)', async () => {
    const bob = principal('user', 'bob');
    const expiry = new Date(clock.now.getTime() + 5_000);
    const live = (): Vote => (clock.now.getTime() < expiry.getTime() ? { model: 'n', permitWhen: TRUE, denyWhen: FALSE, cacheable: true, validUntil: expiry } : { model: 'n', permitWhen: FALSE, denyWhen: FALSE, cacheable: true });
    let checks = 0;
    const listPlan = async (_req: ListPlanRequest, ctx: EvaluationContext) => {
      const hit = ctx.cache.get('bob');
      let answer: Promise<boolean>;
      if (hit instanceof Promise) answer = hit.then((v: unknown) => v === true);
      else {
        checks++;
        answer = ctx.check({ principal: bob, permission: 'doc:write', resource: { type: 'doc', id: 'd1' } }).then((d) => d.allowed);
        ctx.cache.set('bob', answer);
      }
      return (await answer) ? { kind: 'all' } : { kind: 'abstain' };
    };
    const a = make([new KeptModel('n', { vote: live, listPlan })]);
    const scope = { cache: new Map<string, unknown>() };
    const [, second] = await Promise.all([a.accessPlan(alice, 'doc:read', 'doc', undefined, scope), a.accessPlan(alice, 'doc:other', 'doc', undefined, scope)]);

    expect(checks).to.equal(1);
    expect(second.kind === 'filter' ? second.validUntil?.getTime() : undefined).to.equal(expiry.getTime());
    expect(cacheOf(second).ttlMs).to.equal(5_000);
    expect(cacheOf(second).tags).to.include('subject:user:bob');
    clock.advance(6_000);
    expect((await a.accessPlan(alice, 'doc:other', 'doc', undefined, scope)).kind).to.equal('none');
  });

  it('keeps nothing once the request saw a fault a model caught', async () => {
    const m = kept('a', async (req: ListPlanRequest, ctx: EvaluationContext) => {
      if (req.permission.name === 'doc:other') await ctx.ancestors({ type: 'folder', id: 'x' }).catch(() => null);
      return { kind: 'all' };
    });
    const a = new Authorizer({ domain: 'root', models: [m], registry: REG, adapters: [new BrokenAdapter(['folder'])], clock: clock.clock, log: new RecordingLog() });
    const scope = { cache: new Map<string, unknown>() };

    await a.accessPlan(alice, 'doc:other', 'doc', undefined, scope);
    expect((await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope)).cache).to.equal(undefined);
  });

  it('keys by the models versions as well', async () => {
    const m = new VersionedModel('v', { listPlan: { kind: 'all' } });
    const a = make([m]);
    const first = cacheOf(await a.accessPlan(alice, 'doc:read', 'doc')).key;
    m.current = 'v2';

    expect(cacheOf(await a.accessPlan(alice, 'doc:read', 'doc')).key).to.not.equal(first);
  });
});
