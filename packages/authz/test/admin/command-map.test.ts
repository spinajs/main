import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, AuthzAdminReader, AuthzWriteHandler, adminContainer, memoryTx } from '@spinajs/authz';
import type { AdminContext, AuthzAdminQuery, AuthzCommand, AuthzCommandOf, AuthzEvent, AuthzTx, Permission, ResourceRef } from '@spinajs/authz';
import { adminConfig, adminDomain, installHost, instance, rejection, resetHost, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

interface FakeSet {
  readonly kind: 'fake.set';
  readonly scope: ResourceRef;
  readonly key: string;
  readonly value: number;
}

interface FakeValues {
  readonly kind: 'fake.values';
  readonly scope?: ResourceRef;
  readonly page?: { limit: number; offset: number };
}

// A third-party model: its command and query join the core's sets without touching @spinajs/authz.
declare module '@spinajs/authz' {
  interface AuthzCommandMap {
    'fake.set': FakeSet;
  }
  interface AuthzAdminQueryMap {
    'fake.values': FakeValues;
  }
}

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const p1: ResourceRef = { type: 'project', id: 'p1' };

/** The fake model's data, per test domain. */
class FakeValueStore {
  readonly values = new Map<string, number>();
}

class FakeSetHandler extends AuthzWriteHandler {
  static seen: AuthzCommand[] = [];
  readonly kinds = ['fake.set'] as const;

  async validate(c: AuthzCommand): Promise<void> {
    if (c.kind !== 'fake.set') throw new AuthzAdminFailure('invalid_command', `FakeSetHandler got ${c.kind}`, 'kind');
    if (!Number.isInteger(c.value)) throw new AuthzAdminFailure('invalid_command', 'value must be an integer', 'value');
  }

  permission(c: AuthzCommand): { permission: Permission; resource: ResourceRef } {
    return { permission: 'app:settings.manage', resource: (c as FakeSet).scope };
  }

  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    FakeSetHandler.seen.push(c);
    const set = c as FakeSet;
    if (set.key === 'clash') throw new AuthzAdminFailure('conflict', 'the value changed meanwhile', 'key');
    const store = await adminContainer(ctx).resolve(FakeValueStore);
    const before = store.values.get(set.key);
    store.values.set(set.key, set.value);
    memoryTx(tx).onRollback(() => (before === undefined ? store.values.delete(set.key) : store.values.set(set.key, before)));
    return { affected: 1, tags: [`fake:${set.key}`], events: [{ type: 'FakeValueSet', domain: 'forged', actor: { type: 'user', id: 'forged' }, at: new Date(0), data: { key: set.key, value: set.value } }] };
  }
}

class FakeValuesReader extends AuthzAdminReader {
  static calls: AuthzAdminQuery[] = [];
  readonly kinds = ['fake.values'] as const;

  async list(q: AuthzAdminQuery): Promise<{ items: readonly unknown[]; total: number }> {
    FakeValuesReader.calls.push(q);
    return { items: [{ key: 'colour', value: 3 }], total: 1 };
  }
}

async function domain(): Promise<AdminDomain & { readonly fake: FakeValueStore }> {
  const fake = new FakeValueStore();
  const d = await adminDomain('test', {
    register(c) {
      c.register(instance(fake)).as(FakeValueStore);
      c.register(FakeSetHandler).as(AuthzWriteHandler);
      c.register(FakeValuesReader).as(AuthzAdminReader);
    },
  });
  return { ...d, fake };
}

describe('AuthzCommandMap: a third-party model adds admin commands', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
    FakeSetHandler.seen = [];
    FakeValuesReader.calls = [];
  });

  it('types the declared command as an AuthzCommand', () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const yes = <_T extends true>(): void => {};
    yes<Equal<AuthzCommandOf<'fake.set'>, FakeSet>>();
    yes<Equal<Extract<AuthzCommand, { kind: 'fake.set' }>, FakeSet>>();
    yes<Equal<Extract<AuthzAdminQuery, { kind: 'fake.values' }>, FakeValues>>();
    yes<Equal<AuthzCommandOf<'fake.unknown'>, never>>();

    const ok: AuthzCommand = { kind: 'fake.set', scope: p1, key: 'colour', value: 3 };
    // @ts-expect-error value is a number
    const bad: AuthzCommand = { kind: 'fake.set', scope: p1, key: 'colour', value: 'red' };
    // @ts-expect-error no model declares fake.unknown
    const unknown: AuthzCommand = { kind: 'fake.unknown' };
    expect([ok, bad, unknown]).to.have.length(3);
  });

  it('runs the command through AuthzAdmin with its registered AuthzWriteHandler', async () => {
    const d = await domain();
    const out = await d.admin.execute(alice, [{ kind: 'fake.set', scope: p1, key: 'colour', value: 3 }], { reason: 'theme' });
    expect(out).to.deep.equal([{ ok: true, kind: 'fake.set', affected: 1 }]);
    expect(d.fake.values.get('colour')).to.equal(3);
    expect(FakeSetHandler.seen).to.deep.equal([{ kind: 'fake.set', scope: p1, key: 'colour', value: 3 }]);
    expect(d.sink.events.map((e) => [e.type, e.domain, e.data])).to.deep.equal([['FakeValueSet', 'test', { key: 'colour', value: 3 }]]);
    expect(d.bus.published.flatMap((c) => c.tags)).to.deep.equal(['fake:colour']);
    expect(d.audit.of('admin').map((e) => e.permission)).to.deep.equal(['app:settings.manage']);
  });

  it('refuses a command its handler does not validate', async () => {
    const d = await domain();
    const out = await d.admin.execute(alice, [{ kind: 'fake.set', scope: p1, key: 'size', value: 1.5 }]);
    expect(out[0]).to.deep.include({ ok: false, kind: 'fake.set' });
    expect((out[0] as { error: { code: string; field?: string } }).error).to.deep.include({ code: 'invalid_command', field: 'value' });
    expect(FakeSetHandler.seen).to.deep.equal([]);
  });

  it('runs it in one transaction with the batch: a later failure rolls its write back', async () => {
    const d = await domain();
    const out = await d.admin.execute(alice, [
      { kind: 'fake.set', scope: p1, key: 'colour', value: 3 },
      { kind: 'fake.set', scope: p1, key: 'size', value: 2 },
      { kind: 'fake.set', scope: p1, key: 'clash', value: 1 },
    ]);
    expect(out.map((r) => r.ok)).to.deep.equal([true, true, false]);
    expect((out[2] as { error: { code: string } }).error.code).to.equal('conflict');
    expect(d.fake.values.size).to.equal(0);
  });

  it('checks the permission the handler names before it applies', async () => {
    const d = await domain();
    const out = await d.admin.execute(bob, [{ kind: 'fake.set', scope: p1, key: 'colour', value: 3 }]);
    expect(out[0]).to.deep.include({ ok: false, kind: 'fake.set' });
    expect((out[0] as { error: { code: string } }).error.code).to.equal('forbidden');
    expect(FakeSetHandler.seen).to.deep.equal([]);
  });

  it('answers a declared query kind through its registered AuthzAdminReader', async () => {
    const d = await domain();
    const out = await d.admin.list(alice, { kind: 'fake.values', scope: p1 });
    expect(out).to.deep.equal({ items: [{ key: 'colour', value: 3 }], total: 1 });
    expect(FakeValuesReader.calls).to.have.length(1);
    expect(FakeValuesReader.calls[0]).to.deep.include({ kind: 'fake.values', scope: p1, page: { limit: 50, offset: 0 } });
  });

  it('still refuses a query kind no reader claims', async () => {
    const d = await domain();
    const e = await rejection(d.admin.list(alice, { kind: 'fake.unclaimed' } as unknown as AuthzAdminQuery));
    expect((e as AuthzAdminFailure).code).to.equal('invalid_query');
    expect((e as AuthzAdminFailure).field).to.equal('kind');
  });
});
