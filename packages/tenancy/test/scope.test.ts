import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { TenantRequired, TenantSwitchDenied, applyTenantScope, currentTenant, onTenantScopeChange, requireTenant, runAcrossTenants, runInTenant, tenantRef, tenantScope } from '../src/index.js';
import type { ITenantAsyncStorage, TenantScope } from '../src/index.js';
import { establishTenantScope } from '../src/scope.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const store = (): AsyncLocalStorage<Record<string, unknown>> => DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>;

describe('tenant scope', () => {
  it('has no scope outside every run, and "none" is not "all"', () => {
    expect(tenantScope()).to.eq(undefined);
    expect(currentTenant()).to.eq(undefined);
    expect(() => requireTenant()).to.throw(TenantRequired, 'runs with none');
  });

  it('runs fn in one tenant and leaves no scope behind', async () => {
    const seen = await runInTenant('acme', async () => ({ scope: tenantScope(), tenant: currentTenant(), required: requireTenant() }));

    expect(seen.scope).to.deep.eq({ kind: 'tenant', tenant: { id: 'acme' } });
    expect(seen.tenant).to.deep.eq({ id: 'acme' });
    expect(seen.required).to.deep.eq({ id: 'acme' });
    expect(tenantScope()).to.eq(undefined);
  });

  it('takes a TenantRef as well as an id', async () => {
    expect(await runInTenant({ id: 'acme' }, async () => currentTenant()?.id)).to.eq('acme');
  });

  it('refuses an id that is not 1 to 64 characters of a-z, 0-9, "_" and "-"', async () => {
    for (const bad of ['', 'Acme', 'a b', 'a/b', '*', 'acme\n', 'x'.repeat(65)]) {
      await expect(runInTenant(bad, async () => undefined)).to.be.rejectedWith(InvalidArgument);
    }
    expect(tenantRef('a_b-9')).to.deep.eq({ id: 'a_b-9' });
  });

  it('lets a tenant be entered again from inside itself', async () => {
    expect(await runInTenant('acme', () => runInTenant('acme', async () => currentTenant()?.id))).to.eq('acme');
  });

  it('refuses to switch from one tenant to another', async () => {
    await expect(runInTenant('acme', () => runInTenant('globex', async () => undefined))).to.be.rejectedWith(TenantSwitchDenied, 'from tenant "acme" to tenant "globex"');
  });

  it('switches through the cross-tenant scope', async () => {
    const inner = await runInTenant('acme', () => runAcrossTenants('nightly billing', () => runInTenant('globex', async () => currentTenant()?.id)));

    expect(inner).to.eq('globex');
  });

  it('runs across tenants with a reason, where no single tenant is current', async () => {
    const seen = await runAcrossTenants('  nightly billing  ', async () => ({ scope: tenantScope(), tenant: currentTenant() }));

    expect(seen.scope).to.deep.eq({ kind: 'all', reason: 'nightly billing' });
    expect(seen.tenant).to.eq(undefined);
    await expect(runAcrossTenants('nightly billing', async () => requireTenant())).to.be.rejectedWith(TenantRequired, 'nightly billing');
  });

  it('needs a reason to run across tenants', async () => {
    await expect(runAcrossTenants('   ', async () => undefined)).to.be.rejectedWith(InvalidArgument, 'needs a reason');
  });

  it('copies the store it runs in and does not change it', async () => {
    const outer: Record<string, unknown> = { requestId: 'r-1', Principal: { type: 'user', id: 'u1' } };

    const inner = await store().run(outer, () => runInTenant('acme', async () => store().getStore()));

    expect(inner).to.not.eq(outer);
    expect(inner).to.include({ requestId: 'r-1' });
    expect(inner?.Principal).to.eq(outer.Principal);
    expect(inner?.Tenant).to.deep.eq({ kind: 'tenant', tenant: { id: 'acme' } });
    expect(outer).to.not.have.property('Tenant');
  });

  it('freezes the scope it stores', async () => {
    const scope = await runInTenant('acme', async () => tenantScope());

    expect(Object.isFrozen(scope)).to.eq(true);
    expect(Object.isFrozen(scope?.kind === 'tenant' ? scope.tenant : undefined)).to.eq(true);
  });

  it('reads a malformed store key as no scope', () => {
    for (const bad of ['acme', { kind: 'tenant' }, { kind: 'tenant', tenant: { id: 'A' } }, { kind: 'all' }, { kind: 'all', reason: '' }, null]) {
      expect(store().run({ Tenant: bad }, () => tenantScope())).to.eq(undefined);
    }
  });

  it('asks the registered guards before every change of scope, and a guard can refuse it', async () => {
    const changes: [TenantScope | undefined, TenantScope | undefined][] = [];
    const stop = onTenantScopeChange((from, to) => {
      changes.push([from, to]);
      if (to?.kind === 'tenant' && to.tenant.id === 'locked') throw new TenantSwitchDenied('a transaction is open');
    });

    try {
      await runInTenant('acme', () => runInTenant('acme', async () => undefined));
      await expect(runInTenant('locked', async () => undefined)).to.be.rejectedWith(TenantSwitchDenied, 'a transaction is open');
    } finally {
      stop();
    }
    await runInTenant('locked', async () => undefined);

    expect(changes).to.deep.eq([
      [undefined, { kind: 'tenant', tenant: { id: 'acme' } }],
      [undefined, { kind: 'tenant', tenant: { id: 'locked' } }],
    ]);
  });

  it('leaves the outer scope intact when an inner run rejects', async () => {
    const after = await runInTenant('acme', async () => {
      await expect(
        runAcrossTenants('cleanup', async () => {
          throw new Error('inner failure');
        }),
      ).to.be.rejectedWith('inner failure');
      return { scope: tenantScope(), store: store().getStore() };
    });

    expect(after.scope).to.deep.eq({ kind: 'tenant', tenant: { id: 'acme' } });
    expect(after.store?.Tenant).to.eq(after.scope);
  });

  it('asks the guards on a change made by runAcrossTenants and by entry-point glue', async () => {
    const changes: [TenantScope | undefined, TenantScope | undefined][] = [];
    const stop = onTenantScopeChange((from, to) => {
      changes.push([from, to]);
    });

    try {
      await runInTenant('acme', () => runAcrossTenants('nightly billing', async () => undefined));
      await establishTenantScope({ kind: 'tenant', tenant: { id: 'globex' } }, () => establishTenantScope(undefined, async () => undefined));
    } finally {
      stop();
    }

    const acme = { kind: 'tenant', tenant: { id: 'acme' } };
    const globex = { kind: 'tenant', tenant: { id: 'globex' } };
    expect(changes).to.deep.eq([
      [undefined, acme],
      [acme, { kind: 'all', reason: 'nightly billing' }],
      [undefined, globex],
      [globex, undefined],
    ]);
  });

  it('lets entry-point glue replace or drop the ambient scope', async () => {
    const replaced = await runInTenant('acme', () => establishTenantScope({ kind: 'tenant', tenant: { id: 'globex' } }, async () => currentTenant()?.id));
    const dropped = await runInTenant('acme', () => establishTenantScope(undefined, async () => store().getStore()));

    expect(replaced).to.eq('globex');
    expect(dropped).to.not.have.property('Tenant');
  });
});

describe('applyTenantScope', () => {
  type Store = ITenantAsyncStorage & Record<string, unknown>;
  const acme: TenantScope = { kind: 'tenant', tenant: { id: 'acme' } };
  const globex: TenantScope = { kind: 'tenant', tenant: { id: 'globex' } };

  let changes: [TenantScope | undefined, TenantScope | undefined][];
  let stop: () => void;

  beforeEach(() => {
    changes = [];
    stop = onTenantScopeChange((from, to) => {
      changes.push([from, to]);
    });
  });

  afterEach(() => {
    stop();
  });

  it('asks the guards and drops the authz cache on a change of scope', () => {
    const store: Store = { Principal: 'alice', AuthzCache: new Map() };

    applyTenantScope(store, acme);
    expect(store).to.deep.eq({ Principal: 'alice', Tenant: acme });

    store.AuthzCache = new Map();
    applyTenantScope(store, undefined);
    expect(store).to.deep.eq({ Principal: 'alice' });

    expect(changes).to.deep.eq([
      [undefined, acme],
      [acme, undefined],
    ]);
  });

  it('keeps the cache, and asks no guard, for a scope equal to the one in the store', () => {
    const cache = new Map();
    const inAcme: Store = { Tenant: { kind: 'tenant', tenant: { id: 'acme' } }, AuthzCache: cache };
    const acrossAll: Store = { Tenant: { kind: 'all', reason: 'billing' }, AuthzCache: cache };
    const none: Store = { AuthzCache: cache };

    applyTenantScope(inAcme, acme);
    applyTenantScope(acrossAll, { kind: 'all', reason: 'billing' });
    applyTenantScope(none, undefined);

    expect([inAcme.AuthzCache, acrossAll.AuthzCache, none.AuthzCache]).to.deep.eq([cache, cache, cache]);
    expect(inAcme.Tenant).to.deep.eq(acme);
    expect(changes).to.deep.eq([]);
  });

  it('leaves the store untouched when a guard refuses the change', () => {
    const refuse = onTenantScopeChange(() => {
      throw new TenantSwitchDenied('refused');
    });
    const cache = new Map();
    const store: Store = { Tenant: acme, AuthzCache: cache };

    try {
      expect(() => applyTenantScope(store, globex)).to.throw(TenantSwitchDenied, 'refused');
    } finally {
      refuse();
    }

    expect(store.Tenant).to.eq(acme);
    expect(store.AuthzCache).to.eq(cache);
  });
});
