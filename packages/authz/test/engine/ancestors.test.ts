import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import { FALSE, GLOBAL, TRUE } from '../../src/index.js';
import type { Decision, RequestScope, ResourceRef, Vote } from '../../src/index.js';
import { FakeAdapter, FakeRow, RecordingAudit, RecordingLog, StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const F1: ResourceRef = { type: 'folder', id: 'f1' };
const D1: ResourceRef = { type: 'doc', id: 'd1' };
const D2: ResourceRef = { type: 'doc', id: 'd2' };

const authorizer = () =>
  new Authorizer({
    domain: 'root',
    registry: registryOf([{ name: 'doc:read', types: ['doc'] }]),
    models: [],
    adapters: [new FakeAdapter(['doc', 'folder'], { rows: [new FakeRow('doc', 'd1', {}, F1), new FakeRow('folder', 'f1')] })],
    clock: fakeClock().clock,
    audit: new RecordingAudit(),
    log: new RecordingLog(),
  });

describe('Authorizer.ancestors', () => {
  it('answers the path a check walks: the resource, its ancestors, then $global', async () => {
    expect(await authorizer().ancestors(D1)).to.deep.equal([D1, F1, GLOBAL]);
  });

  it('answers null for an unknown resource and [type, $global] at the type level', async () => {
    const a = authorizer();
    expect(await a.ancestors({ type: 'doc', id: 'missing' })).to.equal(null);
    expect(await a.ancestors({ type: 'doc' })).to.deep.equal([{ type: 'doc' }, GLOBAL]);
  });
});

type Reply = (ref: ResourceRef, list: readonly ResourceRef[] | null) => Promise<readonly ResourceRef[] | null>;

/** Answers ancestors() through `reply`; every promise it handed out is kept in `replies`. */
class SlowAncestors extends FakeAdapter {
  readonly replies: Promise<unknown>[] = [];

  constructor(private readonly reply: Reply) {
    super(['doc', 'folder'], { rows: [new FakeRow('doc', 'd1', {}, F1), new FakeRow('doc', 'd2', {}, F1), new FakeRow('folder', 'f1')] });
  }

  ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    this.ancestorCalls.push(ref);
    const p = this.reply(ref, this.chain(ref));
    this.replies.push(p.then(undefined, () => undefined));
    return p;
  }
}

const never = (): Promise<never> => new Promise<never>(() => undefined);
const after = <T>(ms: number, settle: () => T | Promise<T>): Promise<T> => new Promise<void>((resolve) => setTimeout(resolve, ms)).then(settle);

type Raced<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'error'; readonly error: unknown } | { readonly kind: 'hung' };

/** `p` settled within `ms`, or `hung`; the race timer is cleared either way. */
async function race<T>(p: Promise<T>, ms = 1000): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<Raced<T>>((resolve) => (timer = setTimeout(() => resolve({ kind: 'hung' }), ms)));
  try {
    return await Promise.race([p.then((value): Raced<T> => ({ kind: 'value', value }), (error: unknown): Raced<T> => ({ kind: 'error', error })), hung]);
  } finally {
    clearTimeout(timer);
  }
}

const timedOut = (ref: ResourceRef, ms: number) => `ancestors of ${ref.type}:${ref.id} timed out after ${ms} ms`;

function expectTimeout(r: Raced<unknown>, ref: ResourceRef, ms: number): void {
  expect(r.kind).to.equal('error');
  if (r.kind === 'error') expect(r.error).to.be.instanceOf(Error).with.property('message', timedOut(ref, ms));
}

const alice = principal('user', 'alice');
const allowAll = (): StaticModel => new StaticModel('m', { vote: (): Vote => ({ model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true }) });
const timeouts = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

describe('Authorizer: the per-ref ancestors read is bounded by modelTimeoutMs', () => {
  let unhandled: unknown[];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  const make = (adapter: FakeAdapter, modelTimeoutMs = 30): Authorizer =>
    new Authorizer({ domain: 'root', registry: registryOf([{ name: 'doc:read', types: ['doc'] }]), models: [allowAll()], adapters: [adapter], clock: fakeClock().clock, audit: new RecordingAudit(), log: new RecordingLog(), config: { modelTimeoutMs } });

  it('a check whose ancestors() never settles throws the timeout instead of hanging, and never answers allowed @timing', async () => {
    const a = make(new SlowAncestors(never));
    expectTimeout(await race(a.check({ principal: alice, permission: 'doc:read', resource: D1 })), D1, 30);
    expectTimeout(await race(a.ancestors(D1)), D1, 30);
  });

  it('a checkAll entry whose ancestors() never settles fails closed instead of hanging the batch @timing', async () => {
    const adapter = new SlowAncestors((ref, list) => (ref.id === 'd1' ? never() : Promise.resolve(list)));
    const r = await race(make(adapter).checkAll(alice, [{ permission: 'doc:read', resource: D1 }, { permission: 'doc:read', resource: D2 }]));
    // Without per-entry fault isolation the thrown entry rejects the whole batch; with it, that entry alone is model_error.
    if (r.kind === 'value') {
      expect(r.value.map((d: Decision) => [d.resource.id, d.allowed, d.reason?.code])).to.deep.equal([
        ['d1', false, 'model_error'],
        ['d2', true, undefined],
      ]);
    } else expectTimeout(r, D1, 30);
  });

  it('a value ancestors() answers after the timeout is neither used nor kept for a later check of the request @timing', async () => {
    const adapter = new SlowAncestors((_, list) => after(120, () => list));
    const a = make(adapter);
    const scope: RequestScope = { cache: new Map<string, unknown>() };
    expectTimeout(await race(a.check({ principal: alice, permission: 'doc:read', resource: D1 }, scope)), D1, 30);
    await Promise.all(adapter.replies);
    const again = await race(a.check({ principal: alice, permission: 'doc:read', resource: D1 }, scope));
    expectTimeout(again, D1, 30);
    await Promise.all(adapter.replies);
    expect(unhandled).to.deep.equal([]);
  });

  it('a rejection ancestors() answers after the timeout is handled, not left unhandled @timing', async () => {
    const adapter = new SlowAncestors(() => after(80, () => Promise.reject(new Error('ancestor store down'))));
    expectTimeout(await race(make(adapter).check({ principal: alice, permission: 'doc:read', resource: D1 })), D1, 30);
    await Promise.all(adapter.replies);
    await after(20, () => undefined);
    expect(unhandled).to.deep.equal([]);
  });

  it('a read that rejects in time throws the adapter error, not the timeout', async () => {
    const r = await race(make(new SlowAncestors(() => Promise.reject(new Error('ancestor store down')))).check({ principal: alice, permission: 'doc:read', resource: D1 }));
    expect(r.kind).to.equal('error');
    if (r.kind === 'error') expect(r.error).to.be.instanceOf(Error).with.property('message', 'ancestor store down');
  });

  it('a read that settles in time answers as before and leaves no timer behind', async () => {
    const a = make(new SlowAncestors((_, list) => Promise.resolve(list)), 60_000);
    // A first check starts one long-lived timer outside the read path; count after it.
    await a.check({ principal: alice, permission: 'doc:read' });
    const before = timeouts();
    expect((await a.check({ principal: alice, permission: 'doc:read', resource: D1 })).allowed).to.equal(true);
    expect((await a.checkAll(alice, [{ permission: 'doc:read', resource: D2 }])).map((d) => d.allowed)).to.deep.equal([true]);
    expect(await a.ancestors(D1)).to.deep.equal([D1, F1, GLOBAL]);
    expect(timeouts()).to.equal(before);
  });
});
