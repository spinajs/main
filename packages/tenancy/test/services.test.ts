import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { requestScope } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/principal';
import type { TestApp } from '@spinajs/testing';
import {
  ConfigTenantRegistry,
  MemoryTenantRegistry,
  PrincipalAttributeTenantAccess,
  TenantRegistry,
  TenantSwitchDenied,
  TenantUnavailable,
  admitTenant,
  currentTenant,
  forEachTenant,
  runAcrossTenants,
  runInTenant,
  tenantAccess,
  tenantRecord,
  tenantRegistry,
} from '../src/index.js';
import type { TenantRecord, TenantState } from '../src/index.js';
import { tenancyApp } from './support/app.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const user = (id: string, tenants: string[] = []): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: { tenants } });
const anonymous: Principal = { type: 'anonymous', id: 'anonymous', authenticated: false, source: 'anonymous', attributes: {} };

async function memory(): Promise<MemoryTenantRegistry> {
  const inner = (await tenantRegistry()).inner;
  if (!(inner instanceof MemoryTenantRegistry)) throw new Error('expected the memory registry');
  return inner;
}

function authzCache(): Map<string, unknown> {
  const cache = requestScope().cache;
  if (cache === undefined) throw new Error('authz gave no request cache');
  return cache;
}

class UnfilteredTenantRegistry extends MemoryTenantRegistry {
  public override list(): AsyncIterable<TenantRecord> {
    return super.list();
  }
}

/** Fails on the second pull of `list`, then would go on listing. */
class FailingTenantRegistry extends MemoryTenantRegistry {
  public static readonly failure = new Error('registry down');

  public override list(): AsyncIterable<TenantRecord> {
    const tenants = super.list()[Symbol.asyncIterator]();
    let pulls = 0;
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (++pulls === 2 ? Promise.reject(FailingTenantRegistry.failure) : tenants.next()) }),
    };
  }
}

/** Lists its tenants, then one record whose state cannot be read. */
class UnreadableTenantRegistry extends MemoryTenantRegistry {
  public static readonly failure = new Error('unreadable record');

  public override async *list(): AsyncIterable<TenantRecord> {
    yield* super.list();
    yield {
      ...tenantRecord({ id: 'unreadable' }),
      get state(): TenantState {
        throw UnreadableTenantRegistry.failure;
      },
    };
  }
}

const reasonOf = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => 'admitted',
    (err: unknown) => (err instanceof TenantUnavailable ? err.reason : `unexpected ${String(err)}`),
  );

describe('tenancy services', () => {
  let app: TestApp;

  afterEach(async () => {
    await app?.dispose();
  });

  it('uses the config registry and the principal-attribute access by default', async () => {
    app = await tenancyApp();

    expect((await tenantRegistry()).inner).to.be.instanceOf(ConfigTenantRegistry);
    expect(await tenantAccess()).to.be.instanceOf(PrincipalAttributeTenantAccess);
    expect(await tenantRegistry()).to.eq(await tenantRegistry());
  });

  it('picks the registry named by tenancy.registry and refuses an unknown name', async () => {
    app = await tenancyApp({ registry: 'MemoryTenantRegistry' });
    expect((await tenantRegistry()).inner).to.be.instanceOf(MemoryTenantRegistry);
    await app.dispose();

    app = await tenancyApp({ registry: 'NoSuchRegistry' });
    await expect(tenantRegistry()).to.be.rejectedWith('no TenantRegistry is registered under that name');
  });

  it('lets a principal enter the tenants listed in its attributes', async () => {
    const access = new PrincipalAttributeTenantAccess();
    const acme = tenantRecord({ id: 'acme' });

    expect(await access.canEnter(user('alice', ['acme']), acme)).to.eq(true);
    expect(await access.canEnter(user('bob', ['globex']), acme)).to.eq(false);
    expect(await access.canEnter({ ...user('carol'), attributes: { tenants: 'acme' } }, acme)).to.eq(false);
  });

  describe('admitTenant', () => {
    beforeEach(async () => {
      app = await tenancyApp({ registry: 'MemoryTenantRegistry' });
      const registry = await memory();
      registry.add({ id: 'acme', slug: 'acme-inc', domains: ['shop.acme.example'] });
      for (const state of ['suspended', 'provisioning', 'deleting', 'deleted'] as const) registry.add({ id: state, state });
    });

    it('finds the tenant by id, by slug and by domain', async () => {
      expect((await admitTenant('acme')).id).to.eq('acme');
      expect((await admitTenant({ slug: 'acme-inc' })).id).to.eq('acme');
      expect((await admitTenant({ domain: 'shop.acme.example' })).id).to.eq('acme');
    });

    it('refuses a tenant the registry does not know, and a string that is no tenant id', async () => {
      expect(await reasonOf(admitTenant('nobody'))).to.eq('unknown');
      expect(await reasonOf(admitTenant('Not An Id'))).to.eq('unknown');
      expect(await reasonOf(admitTenant({ slug: 'nobody' }))).to.eq('unknown');
    });

    it('refuses a tenant in any state but active', async () => {
      for (const state of ['suspended', 'provisioning', 'deleting', 'deleted']) {
        expect(await reasonOf(admitTenant(state, user('alice', [state])))).to.eq('inactive');
      }
    });

    it('asks TenantAccess for an authenticated principal only', async () => {
      expect(await reasonOf(admitTenant('acme', user('alice', ['acme'])))).to.eq('admitted');
      expect(await reasonOf(admitTenant('acme', user('bob')))).to.eq('forbidden');
      expect(await reasonOf(admitTenant('acme', anonymous))).to.eq('admitted');
      expect(await reasonOf(admitTenant('acme'))).to.eq('admitted');
    });
  });

  describe('forEachTenant', () => {
    beforeEach(async () => {
      app = await tenancyApp({ registry: 'MemoryTenantRegistry' });
      const registry = await memory();
      for (const id of ['a', 'b', 'c', 'd']) registry.add({ id });
      registry.add({ id: 'frozen', state: 'suspended' });
    });

    it('runs fn once per active tenant, each in its own scope', async () => {
      const seen: [string, string | undefined][] = [];

      const report = await forEachTenant(async (tenant) => {
        seen.push([tenant.id, currentTenant()?.id]);
      });

      expect(seen).to.deep.eq([
        ['a', 'a'],
        ['b', 'b'],
        ['c', 'c'],
        ['d', 'd'],
      ]);
      expect(report).to.deep.eq({ total: 4, succeeded: 4, failed: [] });
    });

    it('gives each tenant its own authz request cache', async () => {
      const seen: Record<string, string[]> = {};

      await runAcrossTenants('nightly billing', async () => {
        authzCache().set('outer', true);
        await forEachTenant(async (tenant) => {
          const cache = authzCache();
          seen[tenant.id] = [...cache.keys()];
          cache.set(tenant.id, true);
        });
      });

      expect(seen).to.deep.eq({ a: [], b: [], c: [], d: [] });
    });

    it('visits the states it is given', async () => {
      const seen: string[] = [];

      await forEachTenant(async (tenant) => void seen.push(tenant.id), { states: ['suspended'] });

      expect(seen).to.deep.eq(['frozen']);
    });

    it('visits only the requested states when the registry ignores the filter', async () => {
      await app.dispose();
      app = await tenancyApp({ registry: 'UnfilteredTenantRegistry' }, (container) => container.register(UnfilteredTenantRegistry).as(TenantRegistry));
      const registry = await memory();
      registry.add({ id: 'a' });
      registry.add({ id: 'gone', state: 'deleted' });
      const seen: string[] = [];
      const report = await forEachTenant(async (tenant) => void seen.push(tenant.id));
      expect(seen).to.deep.eq(['a']);
      expect(report.total).to.eq(1);
    });

    it('reports a failing tenant and goes on with the others', async () => {
      const failure = new Error('disk full');

      const report = await forEachTenant(async (tenant) => {
        if (tenant.id === 'b') throw failure;
      });

      expect(report.total).to.eq(4);
      expect(report.succeeded).to.eq(3);
      expect(report.failed).to.deep.eq([{ tenant: 'b', error: failure }]);
    });

    it('runs at most `concurrency` tenants at once', async () => {
      let running = 0;
      let most = 0;

      const report = await forEachTenant(
        async () => {
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, 10));
          running -= 1;
        },
        { concurrency: 3 },
      );

      expect(most).to.eq(3);
      expect(report.succeeded).to.eq(4);
    });

    it('runs one tenant at a time by default', async () => {
      let running = 0;
      let most = 0;

      const report = await forEachTenant(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
      });

      expect(most).to.eq(1);
      expect(report.succeeded).to.eq(4);
    });

    it('starts no tenant after the registry failed, and rejects once the started ones finished', async () => {
      await app.dispose();
      app = await tenancyApp({ registry: 'FailingTenantRegistry' }, (container) => container.register(FailingTenantRegistry).as(TenantRegistry));
      const registry = await memory();
      for (const id of ['a', 'b', 'c']) registry.add({ id });
      const started: string[] = [];
      const finished: string[] = [];

      const run = forEachTenant(
        async (tenant) => {
          started.push(tenant.id);
          await new Promise((resolve) => setTimeout(resolve, 10));
          finished.push(tenant.id);
        },
        { concurrency: 2 },
      );

      await expect(run).to.be.rejectedWith(FailingTenantRegistry.failure);
      expect(finished).to.deep.eq(['a']);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(started).to.deep.eq(['a']);
    });

    it('rejects when the registry yields a record it cannot read, rather than report a shorter run', async () => {
      await app.dispose();
      app = await tenancyApp({ registry: 'UnreadableTenantRegistry' }, (container) => container.register(UnreadableTenantRegistry).as(TenantRegistry));
      (await memory()).add({ id: 'a' });
      const started: string[] = [];

      await expect(forEachTenant(async (tenant) => void started.push(tenant.id))).to.be.rejectedWith(UnreadableTenantRegistry.failure);
      expect(started).to.deep.eq(['a']);
    });

    it('runs from the cross-tenant scope and refuses to run inside one tenant', async () => {
      const report = await runAcrossTenants('nightly billing', () => forEachTenant(async () => undefined));
      expect(report.total).to.eq(4);

      await expect(runInTenant('a', () => forEachTenant(async () => undefined))).to.be.rejectedWith(TenantSwitchDenied, 'inside tenant "a"');
    });

    it('refuses a concurrency that is not a positive integer', async () => {
      await expect(forEachTenant(async () => undefined, { concurrency: 0 })).to.be.rejectedWith(InvalidArgument);
    });
  });
});
