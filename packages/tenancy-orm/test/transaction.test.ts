import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { TenantSwitchDenied, onTenantScopeChange, runAcrossTenants, runInTenant, tenantScopeOf } from '@spinajs/tenancy';
import { carriesTenantSettings, stopTransactionScopeGuard } from '../src/index.js';
import { register, rlsModels, unregisterTenantModel } from '../src/registry.js';
import { refuseScopeChangeInTransaction } from '../src/scope-guard.js';
import { bootApp } from './support/app.js';
import { Ledger, TenantOwned } from './support/models.js';
import { everywhere, inTenant } from './support/scope.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const changed = (from: string, to: string): string =>
  `tenancy-orm: the tenant scope changed from ${from} to ${to} inside an open transaction on connection sqlite; a connection that carries tenant session settings keeps one scope per transaction`;

describe('one tenant scope per transaction (T4)', function () {
  this.timeout(30_000);

  let app: TestApp;
  let driver: OrmDriver;

  before(async () => {
    app = await bootApp();
    const connection = (await app.resolve(Orm)).Connections.get('default');
    if (!connection) throw new Error('no default connection');
    driver = connection;
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await everywhere(() => Ledger.destroy().where('Id', '>', 0));
  });

  const entries = async (): Promise<string[]> => (await everywhere(() => Ledger.query().orderBy('Id'))).map((row) => row.entry);

  it('knows the connection from a subclass of an abstract @Tenant({ rls: true }) base', () => {
    expect(rlsModels()).to.deep.eq([Ledger]);
    expect(carriesTenantSettings(driver)).to.eq(true);
  });

  it('refuses a change of scope inside the transaction, before anything runs in the new scope', async () => {
    let reached = false;
    const moved = inTenant('t1', () =>
      driver.transaction(async () => {
        await Ledger.insert({ entry: 'opening' });
        await runAcrossTenants('month end', async () => {
          reached = true;
        });
      }),
    );
    await expect(moved).to.be.rejectedWith(TenantSwitchDenied, changed('tenant:t1', 'all'));
    expect(reached).to.eq(false);
    expect(await entries()).to.deep.eq([]);
  });

  it('refuses entering a tenant inside a transaction that was opened with no scope or across tenants', async () => {
    await expect(driver.transaction(() => inTenant('t1', () => Ledger.insert({ entry: 'opening' })))).to.be.rejectedWith(TenantSwitchDenied, changed('none', 'tenant:t1'));
    await expect(everywhere(() => driver.transaction(() => inTenant('t2', () => Ledger.query())))).to.be.rejectedWith(TenantSwitchDenied, changed('all', 'tenant:t2'));
    expect(await entries()).to.deep.eq([]);
  });

  it('takes a change to the same kind and tenant as no change', async () => {
    await inTenant('t1', () =>
      driver.transaction(async () => {
        await Ledger.insert({ entry: 'a' });
        refuseScopeChangeInTransaction(tenantScopeOf('t1'), tenantScopeOf('t1'));
        expect(() => refuseScopeChangeInTransaction(tenantScopeOf('t1'), tenantScopeOf('t2'))).to.throw(TenantSwitchDenied, changed('tenant:t1', 'tenant:t2'));
        await runInTenant('t1', async () => await Ledger.insert({ entry: 'b' }));
      }),
    );
    await everywhere(() =>
      driver.transaction(async () => {
        await Ledger.query();
        await runAcrossTenants('nested report', async () => await Ledger.query());
      }),
    );
    expect(await entries()).to.deep.eq(['a', 'b']);
  });

  it('counts .acrossTenants() as another scope when the statement runs', async () => {
    const escaped = inTenant('t1', () =>
      driver.transaction(async () => {
        await Ledger.insert({ entry: 'opening' });
        await Ledger.query().acrossTenants('month end');
      }),
    );
    await expect(escaped).to.be.rejectedWith(TenantSwitchDenied, changed('tenant:t1', 'all'));
  });

  it('still refuses the statement when the scope-change guard is not registered', async () => {
    stopTransactionScopeGuard();
    try {
      const moved = inTenant('t1', () =>
        driver.transaction(async () => {
          await Ledger.insert({ entry: 'opening' });
          await runAcrossTenants('month end', async () => await Ledger.query());
        }),
      );
      await expect(moved).to.be.rejectedWith(TenantSwitchDenied, changed('tenant:t1', 'all'));
      expect(await entries()).to.deep.eq([]);
    } finally {
      onTenantScopeChange(refuseScopeChangeInTransaction);
    }
  });

  it('lets many statements of one scope share a transaction, savepoints included', async () => {
    await inTenant('t1', () =>
      driver.transaction(async () => {
        await Ledger.insert({ entry: 'a' });
        await driver.transaction(async () => await Ledger.insert({ entry: 'b' }));
        await Ledger.update({ entry: 'c' }).where('entry', 'b');
      }),
    );
    expect(await entries()).to.deep.eq(['a', 'c']);
  });

  it('is inert on a connection whose tenant models declare no row level security', async () => {
    unregisterTenantModel(TenantOwned);
    register(TenantOwned, undefined, '@Tenant()');
    try {
      expect(rlsModels()).to.deep.eq([]);
      expect(carriesTenantSettings(driver)).to.eq(false);
      await inTenant('t1', () =>
        driver.transaction(async () => {
          await Ledger.insert({ entry: 'a' });
          await runAcrossTenants('month end', async () => await Ledger.query().acrossTenants('month end'));
        }),
      );
      await driver.transaction(() => inTenant('t2', () => Ledger.insert({ entry: 'b' })));
      expect(await entries()).to.deep.eq(['a', 'b']);
    } finally {
      unregisterTenantModel(TenantOwned);
      register(TenantOwned, { rls: true }, '@Tenant()');
    }
  });
});
