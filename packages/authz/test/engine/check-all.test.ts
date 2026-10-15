import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { l1Key } from '../../src/engine/context.js';
import { FALSE, GLOBAL, TRUE } from '../../src/index.js';
import type { DecisionRequest, ResourceAdapter, ResourceFilter, ResourceRef, Vote } from '../../src/index.js';
import { BatchAdapter, FakeAdapter, FakeRow, LoadingAdapter, RecordingLog, StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const REG = registryOf([
  { name: 'doc:read', types: ['doc'] },
  { name: 'task:read', types: ['task'] },
]);

const alice = principal('user', 'alice');
const owner = (): ResourceFilter => ({ op: 'cmp', field: 'owner', cmp: 'eq', value: { ref: 'principal.id' } });
/** doc:read is unconditional; task:read holds on the rows alice owns. */
const model = (): StaticModel => new StaticModel('m', { vote: (req: DecisionRequest): Vote => ({ model: 'm', permitWhen: req.permission === 'doc:read' ? TRUE : owner(), denyWhen: FALSE, cacheable: true }) });

const d1: ResourceRef = { type: 'doc', id: 'd1' };
const d9: ResourceRef = { type: 'doc', id: 'd9' };
const t1: ResourceRef = { type: 'task', id: 't1' };
const t2: ResourceRef = { type: 'task', id: 't2' };
const docRows = (): FakeRow[] => [new FakeRow('doc', 'd1'), new FakeRow('doc', 'd2')];
const taskRows = (): FakeRow[] => [new FakeRow('task', 't1', { owner: 'alice' }), new FakeRow('task', 't2', { owner: 'bob' })];
const BATCH = [
  { permission: 'task:read', resource: t1 },
  { permission: 'doc:read', resource: d1 },
  { permission: 'task:read', resource: t2 },
  { permission: 'doc:read', resource: d9 },
];

let log: RecordingLog;
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  log = new RecordingLog();
  clock = fakeClock();
});

const make = (adapters: ResourceAdapter[], options: Partial<AuthorizerOptions> = {}): Authorizer => new Authorizer({ domain: 'root', models: [model()], registry: REG, adapters, clock: clock.clock, log, ...options });

describe('Authorizer.checkAll', () => {
  it('answers in input order, each as check() would with the loaded row', async () => {
    const out = await make([new BatchAdapter(['doc'], { kind: 'docs', rows: docRows() }), new BatchAdapter(['task'], { kind: 'tasks', rows: taskRows() })]).checkAll(alice, BATCH);
    expect(out.map((d) => [d.permission, d.resource.id, d.allowed, d.residual.op])).to.deep.equal([
      ['task:read', 't1', true, 'true'],
      ['doc:read', 'd1', true, 'true'],
      ['task:read', 't2', false, 'false'],
      ['doc:read', 'd9', false, 'false'],
    ]);
    expect(out[3].reason?.code).to.equal('unknown_resource');
    const single = make([new BatchAdapter(['task'], { rows: taskRows() })]);
    expect(out[2].reason).to.deep.equal((await single.check({ principal: alice, permission: 'task:read', resource: t2, subject: taskRows()[1] })).reason);
    expect(Object.isFrozen(out)).to.equal(true);
  });

  it('asks each adapter for its ancestors once, with ancestorsMany', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const tasks = new BatchAdapter(['task'], { rows: taskRows() });
    await make([docs, tasks]).checkAll(alice, BATCH);
    expect(docs.ancestorsManyCalls).to.deep.equal([[d1, d9]]);
    expect(tasks.ancestorsManyCalls).to.deep.equal([[t1, t2]]);
    expect(docs.ancestorCalls).to.deep.equal([]);
    expect(tasks.ancestorCalls).to.deep.equal([]);
  });

  it('loads only the rows of conditional decisions, once per type', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const tasks = new BatchAdapter(['task'], { rows: taskRows() });
    await make([docs, tasks]).checkAll(alice, BATCH);
    expect(tasks.loadManyCalls).to.deep.equal([[t1, t2]]);
    expect(docs.loadManyCalls).to.deep.equal([]);
    expect(tasks.loadCalls).to.deep.equal([]);
  });

  it('fills the shared request scope with the ancestors', async () => {
    const scope = { cache: new Map<string, unknown>() };
    await make([new BatchAdapter(['doc'], { rows: docRows() })]).checkAll(alice, [{ permission: 'doc:read', resource: d1 }, { permission: 'doc:read', resource: d9 }], scope);
    expect(scope.cache.get(l1Key('ancestors', 'root', 'doc:d1'))).to.deep.equal([d1, GLOBAL]);
    expect(scope.cache.get(l1Key('ancestors', 'root', 'doc:d9'))).to.equal(null);
  });

  it('asks about a ref named twice once', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const out = await make([docs]).checkAll(alice, [{ permission: 'doc:read', resource: d1 }, { permission: 'doc:read', resource: d1 }]);
    expect(out.map((d) => d.allowed)).to.deep.equal([true, true]);
    expect(docs.ancestorsManyCalls).to.deep.equal([[d1]]);
  });

  it('does not batch type-level refs', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const out = await make([docs]).checkAll(alice, [{ permission: 'doc:read', resource: { type: 'doc' } }]);
    expect(out[0].allowed).to.equal(true);
    expect(docs.ancestorsManyCalls).to.deep.equal([]);
  });

  it('falls back to ancestors() and load() per ref without the batch methods', async () => {
    const tasks = new LoadingAdapter(['task'], { rows: taskRows() });
    const out = await make([tasks]).checkAll(alice, [{ permission: 'task:read', resource: t1 }, { permission: 'task:read', resource: t2 }]);
    expect(out.map((d) => d.allowed)).to.deep.equal([true, false]);
    expect(tasks.ancestorCalls).to.deep.equal([t1, t2]);
    expect(tasks.loadCalls).to.deep.equal([t1, t2]);
  });

  it('leaves a decision conditional when the adapter cannot load rows', async () => {
    const out = await make([new FakeAdapter(['task'], { rows: taskRows() })]).checkAll(alice, [{ permission: 'task:read', resource: t1 }]);
    expect(out[0].allowed).to.equal(true);
    expect(out[0].residual.op).to.equal('cmp');
  });

  it('denies with unknown_resource when loadMany has no row for a known node', async () => {
    const tasks = new BatchAdapter(['task'], { rows: taskRows(), nodes: { 'task:t3': null } });
    const out = await make([tasks]).checkAll(alice, [{ permission: 'task:read', resource: { type: 'task', id: 't3' } }]);
    expect(out[0].allowed).to.equal(false);
    expect(out[0].reason).to.deep.equal({ code: 'unknown_resource' });
  });

  it('denies the conditional decisions with model_error when loadMany fails, and logs it', async () => {
    const tasks = new BatchAdapter(['task'], { rows: taskRows(), failLoadMany: true });
    const out = await make([tasks]).checkAll(alice, [{ permission: 'task:read', resource: t1 }]);
    expect(out[0].allowed).to.equal(false);
    expect(out[0].residual).to.deep.equal(FALSE);
    expect(out[0].reason).to.deep.equal({ code: 'model_error' });
    expect(log.at('error').map((e) => e.message).join('\n')).to.match(/loadMany/);
  });

  it('falls back to ancestors() per ref when ancestorsMany fails, and logs it', async () => {
    const tasks = new BatchAdapter(['task'], { rows: taskRows(), failAncestorsMany: true });
    const out = await make([tasks]).checkAll(alice, [{ permission: 'task:read', resource: t1 }, { permission: 'task:read', resource: t2 }]);
    expect(out.map((d) => d.allowed)).to.deep.equal([true, false]);
    expect(tasks.ancestorCalls).to.deep.equal([t1, t2]);
    expect(log.at('error').map((e) => e.message).join('\n')).to.match(/ancestorsMany/);
  });

  it('answers invalid_request for an unregistered permission or a type outside its types, and checks the rest', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const out = await make([docs]).checkAll(alice, [
      { permission: 'doc:nope', resource: d1 },
      { permission: 'doc:read', resource: t1 },
      { permission: 'doc:read', resource: d1 },
    ]);
    expect(out.map((d) => [d.permission, d.allowed, d.reason?.code])).to.deep.equal([
      ['doc:nope', false, 'invalid_request'],
      ['doc:read', false, 'invalid_request'],
      ['doc:read', true, undefined],
    ]);
    expect(out[0].residual).to.deep.equal(FALSE);
    expect(docs.ancestorsManyCalls).to.deep.equal([[d1]]);
  });
});
