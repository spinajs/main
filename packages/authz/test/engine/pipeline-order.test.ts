import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { DecisionCache, FALSE, SYSTEM, TRUE, UNATTENDED } from '../../src/index.js';
import type { Decision, DecisionRequest, ResourceFilter, ResourceRef, Vote } from '../../src/index.js';
import { FakeAdapter, FakeRelation, FakeRow, RecordingAudit, StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

// Pins the order of the check pipeline's steps (design §10.1): what it calls outside the engine and the core trace steps.

const registry = registryOf([{ name: 'doc:read', types: ['doc'], fields: true }]);
const cmp = (field: string, value: string): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value });
const owner: ResourceFilter = { op: 'relation', relation: 'owner' };
const vote = (model: string, permitWhen: ResourceFilter, extra: Partial<Vote> = {}): Vote => ({ model, permitWhen, denyWhen: FALSE, cacheable: true, ...extra });

class LoggingAdapter extends FakeAdapter {
  constructor(private readonly log: string[], rows: readonly FakeRow[], relation: FakeRelation) {
    super(['doc'], { rows, relations: [relation] });
  }

  override async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    this.log.push(`ancestors ${ref.type}:${ref.id ?? '*'}`);
    return super.ancestors(ref);
  }
}

class LoggingCache extends DecisionCache {
  readonly entries = new Map<string, Decision>();
  constructor(private readonly log: string[]) {
    super();
  }

  get(key: string): Decision | undefined {
    this.log.push('cache.get');
    return this.entries.get(key);
  }

  set(key: string, d: Decision): void {
    this.log.push('cache.set');
    this.entries.set(key, d);
  }

  invalidate(): void {
    this.log.push('cache.invalidate');
  }
}

class LoggingAudit extends RecordingAudit {
  constructor(private readonly log: string[]) {
    super();
  }

  override record(e: Parameters<RecordingAudit['record']>[0]): void | Promise<void> {
    this.log.push(`audit ${e.kind}`);
    return super.record(e);
  }
}

function setup(models: (log: string[]) => StaticModel[], options: Partial<AuthorizerOptions> = {}) {
  const log: string[] = [];
  const relation = new FakeRelation('doc', 'owner', (p, _ref, subject) => {
    log.push(`relation owner ${p.id}`);
    return (subject as FakeRow).owner === p.id;
  });
  const rows = [new FakeRow('doc', 'd1', { owner: 'alice', a: '1' }), new FakeRow('doc', 'd2', { owner: 'bob', a: '2' })];
  const a = new Authorizer({ domain: 'root', registry, models: models(log), adapters: [new LoggingAdapter(log, rows, relation)], cache: new LoggingCache(log), audit: new LoggingAudit(log), clock: fakeClock().clock, ...options });
  return { a, log, rows };
}

const model = (log: string[], name: string, answer: (req: DecisionRequest) => Vote, principalTypes?: string[]) =>
  new StaticModel(name, {
    ...(principalTypes ? { capabilities: { principalTypes } } : {}),
    vote: (req: DecisionRequest) => {
      log.push(`evaluate ${name} as ${req.principal.id}`);
      return answer(req);
    },
  });

const coreSteps = (d: Decision): string[] => (d.trace?.steps ?? []).filter((s) => s.by === 'core').map((s) => s.step);

const alice = principal('user', 'alice');
const bob = principal('user', 'bob');

describe('pipeline order', () => {
  it('a check: ancestors, then the L2 lookup, the models in plan order and the store; an allow is not audited', async () => {
    const { a, log } = setup((l) => [model(l, 'm1', () => vote('m1', TRUE)), model(l, 'm2', () => vote('m2', cmp('a', '1')))]);
    const d = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    expect(d.allowed).to.equal(true);
    expect(log).to.deep.equal(['ancestors doc:d1', 'cache.get', 'evaluate m1 as alice', 'evaluate m2 as alice', 'cache.set']);
  });

  it('a second check of the same request scope is an L1 hit: no adapter, cache or model call', async () => {
    const { a, log } = setup((l) => [model(l, 'm1', () => vote('m1', TRUE))]);
    const scope = { cache: new Map<string, unknown>() };
    await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } }, scope);
    log.length = 0;
    await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } }, scope);
    expect(log).to.deep.equal([]);
  });

  it('explain of a denial against the subject: no cache, the subject step, the reason pass, then the audits', async () => {
    const { a, log, rows } = setup((l) => [model(l, 'm1', () => vote('m1', owner))]);
    const d = await a.explain({ principal: bob, permission: 'doc:read', resource: rows[0] });
    expect(d.allowed).to.equal(false);
    expect(coreSteps(d)).to.deep.equal(['resource', 'route', 'combine', 'subject', 'reason']);
    expect(log).to.deep.equal(['ancestors doc:d1', 'evaluate m1 as bob', 'relation owner bob', 'relation owner bob', 'audit deny', 'audit explain']);
  });

  it('an intersect delegate is checked before the models, and its stripped type-level residual after the combine', async () => {
    const agent = principal('agent', 'bot', { onBehalfOf: alice, delegation: 'intersect' });
    const { a, log, rows } = setup((l) => [model(l, 'm1', () => vote('m1', owner))]);
    const d = await a.explain({ principal: agent, permission: 'doc:read', resource: rows[0] });
    expect(coreSteps(d)).to.deep.equal(['resource', 'delegation', 'route', 'delegation', 'combine', 'reason']);
    expect(log).to.deep.equal(['ancestors doc:d1', 'evaluate m1 as alice', 'relation owner alice', 'evaluate m1 as bot', 'evaluate m1 as alice', 'relation owner bot', 'audit deny', 'audit explain']);
  });

  it('inherit delegation runs the models as the delegate; a model that does not serve the type is skipped before the route', async () => {
    const agent = principal('agent', 'bot', { onBehalfOf: alice, delegation: 'inherit' });
    const { a, log } = setup((l) => [model(l, 'agents', () => vote('agents', TRUE), ['agent']), model(l, 'users', () => vote('users', TRUE), ['user'])]);
    const d = await a.explain({ principal: agent, permission: 'doc:read', resource: { type: 'doc', id: 'd2' } });
    expect(coreSteps(d)).to.deep.equal(['resource', 'delegation', 'skip', 'route', 'combine']);
    expect(log).to.deep.equal(['ancestors doc:d2', 'evaluate users as alice', 'audit explain']);
  });

  it('SYSTEM, UNATTENDED and an unknown resource stop before the models', async () => {
    const { a, log } = setup((l) => [model(l, 'm1', () => vote('m1', TRUE))]);
    const system = await a.explain({ principal: SYSTEM, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    const unattended = await a.explain({ principal: UNATTENDED, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    const unknown = await a.explain({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'nope' } });
    expect([coreSteps(system), coreSteps(unattended), coreSteps(unknown)]).to.deep.equal([
      ['resource', 'principal'],
      ['resource', 'principal'],
      ['resource', 'resource'],
    ]);
    expect(log).to.deep.equal(['audit system', 'audit explain', 'audit deny', 'audit explain', 'ancestors doc:nope', 'audit deny', 'audit explain']);
  });
});
