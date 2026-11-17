import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ConcurrencyConflict, InvalidOperation } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { TENANT_STATES, TenantUnavailable } from '@spinajs/tenancy';
import type { TenantState } from '@spinajs/tenancy';
import { DateTime } from 'luxon';
import { TENANCY_CONNECTION, TENANTS_TABLE, TenantModel, TenantStateService, Tenants_2026_11_16_00_00_00, canTransition, isTenantState, nextStates, toTenantRecord } from '../src/index.js';
import { bootApp } from './support/app.js';
import { clearTenants, seedTenant } from './support/tenants.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const LEGAL = ['active>suspended', 'deleting>deleted', 'provisioning>active', 'provisioning>deleting', 'suspended>active', 'suspended>deleting'];

// Another worker moves the tenant between the read and the update.
class Raced extends TenantStateService {
  protected override async current(id: string): Promise<TenantModel> {
    const row = await super.current(id);
    await TenantModel.update({ state: 'suspended', updated_at: DateTime.utc() }).where('id', id);
    return row;
  }
}

describe('tenant table and state machine', function () {
  this.timeout(30_000);

  let app: TestApp;

  before(async () => {
    app = await bootApp();
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await clearTenants();
  });

  it('allows exactly the steps of the state machine, the way out of a failed provisioning included', () => {
    const allowed: string[] = [];
    for (const from of TENANT_STATES) {
      for (const to of TENANT_STATES) {
        if (canTransition(from, to)) allowed.push(`${from}>${to}`);
      }
    }
    expect(allowed.sort()).to.deep.eq(LEGAL);
    expect(nextStates('deleted')).to.deep.eq([]);
    expect(canTransition('provisioning', 'deleting')).to.eq(true);
    expect(canTransition('provisioning', 'suspended')).to.eq(false);
    expect(canTransition('provisioning', 'deleted')).to.eq(false);
    expect(TENANT_STATES.every((state) => isTenantState(state))).to.eq(true);
    expect([undefined, null, '', 'Active', 'frozen', 1].some((value) => isTenantState(value))).to.eq(false);
  });

  it('keeps a tenant in the tenants table and reads it back as a record', async () => {
    await seedTenant({ id: 't1', slug: 'acme', name: 'Acme', domains: ['acme.example', 'www.acme.example'], placement: { kind: 'schema', schema: 't_t1' }, settings: { 'intl.defaultLocale': 'pl' } });
    await seedTenant({ id: 't2' });

    const [first, second] = await TenantModel.query().orderBy('id');
    expect(toTenantRecord(first)).to.deep.eq({ id: 't1', slug: 'acme', name: 'Acme', state: 'active', domains: ['acme.example', 'www.acme.example'], placement: { kind: 'schema', schema: 't_t1' }, settings: { 'intl.defaultLocale': 'pl' } });
    expect(toTenantRecord(second)).to.deep.eq({ id: 't2', slug: 't2', name: 't2', state: 'active', domains: [], settings: {} });
  });

  it('refuses a row whose state it does not know', async () => {
    await seedTenant({ id: 't1' });
    const driver = (await app.resolve(Orm)).Connections.get(TENANCY_CONNECTION);
    await driver?.update().in(TENANTS_TABLE).update({ state: 'frozen' }).where('id', 't1');

    const [row] = await TenantModel.where('id', 't1');
    expect(() => toTenantRecord(row)).to.throw(InvalidOperation, 'tenancy-orm: tenant "t1" has the unknown state "frozen"');
    const states = await app.resolve(TenantStateService);
    await expect(states.transition('t1', 'active')).to.be.rejectedWith(InvalidOperation, 'tenancy-orm: tenant "t1" cannot go from frozen to active');
  });

  it('refuses a row whose id, placement or settings it cannot read', async () => {
    const rows: Record<string, Record<string, string>> = {
      t1: { placement: '{"kind":"other","schema":"t_t1"}' },
      t2: { placement: '{"kind":"schema","schema":""}' },
      t3: { placement: '[]' },
      t4: { settings: '["a"]' },
      t5: { settings: 'null' },
      T6: {},
    };
    const driver = (await app.resolve(Orm)).Connections.get(TENANCY_CONNECTION);
    for (const [id, values] of Object.entries(rows)) {
      await seedTenant({ id });
      if (Object.keys(values).length > 0) await driver?.update().in(TENANTS_TABLE).update(values).where('id', id);
    }

    const messages = (await TenantModel.query().orderBy('id')).map((row): unknown => {
      try {
        return toTenantRecord(row);
      } catch (err: unknown) {
        return err instanceof InvalidOperation ? err.message : err;
      }
    });
    expect(messages).to.deep.eq([
      'tenancy-orm: the tenant row "T6" has an id that is not a tenant id',
      'tenancy-orm: tenant "t1" has the unreadable placement {"kind":"other","schema":"t_t1"}',
      'tenancy-orm: tenant "t2" has the unreadable placement {"kind":"schema","schema":""}',
      'tenancy-orm: tenant "t3" has the unreadable placement []',
      'tenancy-orm: tenant "t4" has the unreadable settings ["a"]',
      'tenancy-orm: tenant "t5" has the unreadable settings null',
    ]);
  });

  it('takes an id that is not a tenant id as no tenant', async () => {
    await seedTenant({ id: 'T1' });
    const states = await app.resolve(TenantStateService);
    const unknown: unknown = await states.transition('T1', 'suspended').catch((err: unknown) => err);
    expect(unknown).to.be.instanceOf(TenantUnavailable);
    expect(unknown).to.include({ reason: 'unknown', message: 'tenancy-orm: no tenant "T1"' });
    const [row] = await TenantModel.where('id', 'T1');
    expect(row.state).to.eq('active');
  });

  it('drops the table and creates it again', async () => {
    const driver = (await app.resolve(Orm)).Connections.get(TENANCY_CONNECTION);
    if (driver === undefined) throw new Error('no tenancy connection');
    await new Tenants_2026_11_16_00_00_00().down(driver);
    await expect(TenantModel.query()).to.be.rejected;
    await new Tenants_2026_11_16_00_00_00().up(driver);
    expect(await TenantModel.query()).to.deep.eq([]);
  });

  it('moves a tenant along the machine', async () => {
    await seedTenant({ id: 't1', state: 'provisioning' });
    const states = await app.resolve(TenantStateService);
    const path: TenantState[] = ['active', 'suspended', 'active', 'suspended', 'deleting', 'deleted'];
    for (const to of path) {
      expect((await states.transition('t1', to)).state).to.eq(to);
    }
    const [row] = await TenantModel.where('id', 't1');
    expect(row.state).to.eq('deleted');
  });

  it('refuses a step the machine does not have, and a tenant it does not know', async () => {
    await seedTenant({ id: 't1' });
    const states = await app.resolve(TenantStateService);
    await expect(states.transition('t1', 'deleted')).to.be.rejectedWith(InvalidOperation, 'tenancy-orm: tenant "t1" cannot go from active to deleted');
    await expect(states.transition('t1', 'active')).to.be.rejectedWith(InvalidOperation, 'tenancy-orm: tenant "t1" cannot go from active to active');
    const unknown: unknown = await states.transition('nope', 'active').catch((err: unknown) => err);
    expect(unknown).to.be.instanceOf(TenantUnavailable);
    expect(unknown).to.include({ reason: 'unknown', message: 'tenancy-orm: no tenant "nope"' });
    const [row] = await TenantModel.where('id', 't1');
    expect(row.state).to.eq('active');
  });

  it('deletes a tenant whose provisioning did not finish, and nothing else from provisioning', async () => {
    await seedTenant({ id: 't1', state: 'provisioning' });
    const states = await app.resolve(TenantStateService);
    await expect(states.transition('t1', 'suspended')).to.be.rejectedWith(InvalidOperation, 'tenancy-orm: tenant "t1" cannot go from provisioning to suspended');
    await expect(states.transition('t1', 'deleted')).to.be.rejectedWith(InvalidOperation, 'tenancy-orm: tenant "t1" cannot go from provisioning to deleted');
    expect((await states.transition('t1', 'deleting')).state).to.eq('deleting');
    expect((await states.transition('t1', 'deleted')).state).to.eq('deleted');
  });

  it('refuses a tenant that another worker moved meanwhile', async () => {
    await seedTenant({ id: 't1' });
    await expect(new Raced().transition('t1', 'suspended')).to.be.rejectedWith(ConcurrencyConflict, 'tenancy-orm: tenant "t1" left state active while it was moved to suspended');
    const [row] = await TenantModel.where('id', 't1');
    expect(row.state).to.eq('suspended');
  });

  it('lets one of two concurrent moves from one state win', async () => {
    await seedTenant({ id: 't1' });
    const states = await app.resolve(TenantStateService);
    const results = await Promise.allSettled([states.transition('t1', 'suspended'), states.transition('t1', 'suspended')]);
    expect(results.filter((result) => result.status === 'fulfilled')).to.have.length(1);
    const [lost] = results.flatMap((result): unknown[] => (result.status === 'rejected' ? [result.reason] : []));
    expect(lost).to.be.instanceOf(ConcurrencyConflict);
  });
});
