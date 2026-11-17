import 'mocha';
import { expect } from 'chai';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';
import { CachedTenantRegistry, ConfigTenantRegistry, MemoryTenantRegistry, TenantRegistry, tenantRecord } from '../src/index.js';
import type { TenantRecord, TenantState } from '../src/index.js';
import { tenancyApp } from './support/app.js';

async function ids(registry: TenantRegistry, filter?: { states?: TenantState[] }): Promise<string[]> {
  const found: string[] = [];
  for await (const record of registry.list(filter)) found.push(record.id);
  return found;
}

/** A registry that counts the lookups that reach it. */
class CountingRegistry extends TenantRegistry {
  public calls = 0;
  public readonly memory = new MemoryTenantRegistry();
  /** While set, `get` and `find` read the record at once and answer only when the gate opens. */
  public gate?: Promise<void>;

  constructor(private readonly cached = true) {
    super();
  }

  public override get cacheable(): boolean {
    return this.cached;
  }

  public async get(id: string): Promise<TenantRecord | undefined> {
    this.calls += 1;
    const record = await this.memory.get(id);
    await this.gate;
    return record;
  }

  public async find(by: { slug?: string; domain?: string }): Promise<TenantRecord | undefined> {
    this.calls += 1;
    const record = await this.memory.find(by);
    await this.gate;
    return record;
  }

  public list(filter?: { states?: TenantState[] }): AsyncIterable<TenantRecord> {
    return this.memory.list(filter);
  }
}

describe('tenantRecord', () => {
  it('defaults the slug and the name to the id and the state to active', () => {
    expect(tenantRecord({ id: 'acme' })).to.deep.eq({ id: 'acme', slug: 'acme', name: 'acme', state: 'active', domains: [], settings: {} });
  });

  it('lower-cases domains, keeps a placement, and is frozen', () => {
    const record = tenantRecord({ id: 'acme', domains: ['Shop.Acme.Example'], placement: { kind: 'schema', schema: 't_acme' } });

    expect(record.domains).to.deep.eq(['shop.acme.example']);
    expect(record.placement).to.deep.eq({ kind: 'schema', schema: 't_acme' });
    expect(Object.isFrozen(record)).to.eq(true);
  });

  it('refuses an id outside the tenant id alphabet', () => {
    expect(() => tenantRecord({ id: 'Acme Inc' })).to.throw(InvalidArgument);
  });
});

describe('MemoryTenantRegistry', () => {
  const registry = (): MemoryTenantRegistry => {
    const memory = new MemoryTenantRegistry();
    memory.add({ id: 'acme', domains: ['shop.acme.example'] });
    memory.add({ id: 'globex', slug: 'gx', state: 'suspended' });
    return memory;
  };

  it('finds a tenant by id, by slug and by domain, whatever the case of the domain', async () => {
    const memory = registry();

    expect((await memory.get('acme'))?.id).to.eq('acme');
    expect((await memory.find({ slug: 'gx' }))?.id).to.eq('globex');
    expect((await memory.find({ domain: 'SHOP.acme.example' }))?.id).to.eq('acme');
    expect(await memory.get('nobody')).to.eq(undefined);
    expect(await memory.find({})).to.eq(undefined);
  });

  it('lists every tenant, or those in the given states', async () => {
    const memory = registry();

    expect(await ids(memory)).to.deep.eq(['acme', 'globex']);
    expect(await ids(memory, { states: ['active'] })).to.deep.eq(['acme']);
  });

  it('patches a tenant and never changes its id', async () => {
    const memory = registry();

    const patched = memory.set('acme', { state: 'suspended', name: 'Acme Ltd', id: 'other' });

    expect(patched).to.include({ id: 'acme', state: 'suspended', name: 'Acme Ltd' });
    expect(await memory.get('other')).to.eq(undefined);
    expect(() => memory.set('nobody', { name: 'x' })).to.throw(InvalidArgument, 'no tenant "nobody"');
  });

  it('is not cacheable', () => {
    expect(registry().cacheable).to.eq(false);
  });
});

describe('ConfigTenantRegistry', () => {
  let app: TestApp;

  afterEach(async () => {
    await app?.dispose();
  });

  it('answers from tenancy.tenants', async () => {
    app = await tenancyApp({
      tenants: [
        { id: 'acme', domains: ['Shop.Acme.Example'] },
        { id: 'globex', slug: 'gx', name: 'Globex', state: 'suspended', placement: { kind: 'schema', schema: 't_globex' }, settings: { plan: 'pro' } },
      ],
    });
    const registry = await app.resolve(ConfigTenantRegistry);

    expect(await registry.get('acme')).to.deep.eq({ id: 'acme', slug: 'acme', name: 'acme', state: 'active', domains: ['shop.acme.example'], settings: {} });
    expect(await registry.find({ slug: 'gx' })).to.deep.eq({ id: 'globex', slug: 'gx', name: 'Globex', state: 'suspended', domains: [], placement: { kind: 'schema', schema: 't_globex' }, settings: { plan: 'pro' } });
    expect((await registry.find({ domain: 'shop.acme.example' }))?.id).to.eq('acme');
    expect(await ids(registry, { states: ['active'] })).to.deep.eq(['acme']);
    expect(registry.cacheable).to.eq(false);
  });

  it('refuses a state the schema would refuse, rather than making the tenant active', () => {
    const registry = new ConfigTenantRegistry();
    Object.defineProperty(registry, 'Listed', { value: [{ id: 'acme', state: 'disabled' }] });
    expect(() => registry.get('acme')).to.throw(InvalidOption, 'tenancy.tenants[0].state "disabled" is not a tenant state');
  });

  it('refuses an id, a slug or a domain listed for two tenants', () => {
    const cases: [unknown[], string][] = [
      [[{ id: 'acme' }, { id: 'acme', name: 'Acme again' }], 'tenancy.tenants[1].id "acme" is already used by tenancy.tenants[0]'],
      [[{ id: 'a', slug: 'shop' }, { id: 'b' }, { id: 'c', slug: 'shop' }], 'tenancy.tenants[2].slug "shop" is already used by tenancy.tenants[0]'],
      [[{ id: 'a', domains: ['Shop.Example'] }, { id: 'b', domains: ['shop.example'] }], 'tenancy.tenants[1].domains "shop.example" is already used by tenancy.tenants[0]'],
    ];
    for (const [listed, message] of cases) {
      const registry = new ConfigTenantRegistry();
      Object.defineProperty(registry, 'Listed', { value: listed });
      expect(() => registry.get('acme')).to.throw(InvalidOption, message);
    }
  });

  it('is empty without the key', async () => {
    app = await tenancyApp();

    expect(await ids(await app.resolve(ConfigTenantRegistry))).to.deep.eq([]);
  });
});

describe('CachedTenantRegistry', () => {
  let now = 0;
  const cached = (inner: CountingRegistry, ttl = 5000): CachedTenantRegistry => new CachedTenantRegistry(inner, () => ttl, () => now);

  beforeEach(() => {
    now = 1_000;
  });

  it('answers get from the cache until the ttl passed', async () => {
    const inner = new CountingRegistry();
    inner.memory.add({ id: 'acme' });
    const registry = cached(inner);

    await registry.get('acme');
    now += 4_999;
    expect((await registry.get('acme'))?.id).to.eq('acme');
    expect(inner.calls).to.eq(1);

    now += 1;
    await registry.get('acme');
    expect(inner.calls).to.eq(2);
  });

  it('remembers a miss, and invalidate(id) forgets the tenant and every miss', async () => {
    const inner = new CountingRegistry();
    const registry = cached(inner);

    expect(await registry.get('acme')).to.eq(undefined);
    expect(await registry.find({ slug: 'acme' })).to.eq(undefined);
    inner.memory.add({ id: 'acme' });
    expect(await registry.get('acme')).to.eq(undefined);
    expect(inner.calls).to.eq(2);

    registry.invalidate('acme');
    expect((await registry.get('acme'))?.id).to.eq('acme');
    expect((await registry.find({ slug: 'acme' }))?.id).to.eq('acme');
  });

  it('shows a changed tenant after invalidate(id), also through find', async () => {
    const inner = new CountingRegistry();
    inner.memory.add({ id: 'acme', domains: ['shop.acme.example'] });
    const registry = cached(inner);

    expect((await registry.find({ domain: 'Shop.Acme.Example' }))?.state).to.eq('active');
    expect((await registry.get('acme'))?.state).to.eq('active');
    expect(inner.calls).to.eq(1);

    inner.memory.set('acme', { state: 'suspended' });
    registry.invalidate('acme');
    expect((await registry.find({ domain: 'shop.acme.example' }))?.state).to.eq('suspended');
  });

  it('keeps nothing a lookup found while invalidate(id) or invalidate() ran', async () => {
    for (const forget of [(registry: CachedTenantRegistry) => registry.invalidate('acme'), (registry: CachedTenantRegistry) => registry.invalidate()]) {
      const inner = new CountingRegistry();
      inner.memory.add({ id: 'acme' });
      let open = (): void => undefined;
      inner.gate = new Promise((resolve) => (open = resolve));
      const registry = cached(inner);
      const stale = registry.get('acme');
      inner.memory.set('acme', { state: 'suspended' });
      forget(registry);
      open();
      expect((await stale)?.state).to.eq('active');
      expect((await registry.get('acme'))?.state).to.eq('suspended');
      expect(inner.calls).to.eq(2);
    }
  });

  it('keeps nothing a find by slug or by domain found while invalidate(id) ran', async () => {
    for (const by of [{ slug: 'acme' }, { domain: 'shop.acme.example' }]) {
      const inner = new CountingRegistry();
      inner.memory.add({ id: 'acme', domains: ['shop.acme.example'] });
      let open = (): void => undefined;
      inner.gate = new Promise((resolve) => (open = resolve));
      const registry = cached(inner);
      const stale = registry.find(by);
      inner.memory.set('acme', { state: 'suspended' });
      registry.invalidate('acme');
      open();
      expect((await stale)?.state).to.eq('active');
      expect((await registry.find(by))?.state).to.eq('suspended');
      expect(inner.calls).to.eq(2);
    }
  });

  it('counts the ttl from the start of the lookup', async () => {
    const inner = new CountingRegistry();
    inner.memory.add({ id: 'acme' });
    let open = (): void => undefined;
    inner.gate = new Promise((resolve) => (open = resolve));
    const registry = cached(inner);
    const first = registry.get('acme');
    now += 3_000;
    open();
    await first;
    now += 2_000;
    await registry.get('acme');
    expect(inner.calls).to.eq(2);
  });

  it('forgets everything on invalidate()', async () => {
    const inner = new CountingRegistry();
    inner.memory.add({ id: 'acme' });
    const registry = cached(inner);

    await registry.get('acme');
    registry.invalidate();
    await registry.get('acme');

    expect(inner.calls).to.eq(2);
  });

  it('caches nothing with a ttl of 0 or over a registry that is not cacheable', async () => {
    const off = new CountingRegistry();
    const local = new CountingRegistry(false);
    for (const [inner, registry] of [[off, cached(off, 0)], [local, cached(local)]] as const) {
      await registry.get('acme');
      await registry.get('acme');
      expect(inner.calls).to.eq(2);
    }
  });

  it('never caches list', async () => {
    const inner = new CountingRegistry();
    const registry = cached(inner);

    expect(await ids(registry)).to.deep.eq([]);
    inner.memory.add({ id: 'acme' });
    expect(await ids(registry)).to.deep.eq(['acme']);
  });
});
