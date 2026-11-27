import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ConcurrencyConflict, InvalidOperation } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';
import { TenantUnavailable, admitTenant, tenantRegistry } from '@spinajs/tenancy';

import { TenantLifecycle, TenantModel, TenantStateService } from '../../src/index.js';
import type { TenantLifecycleState } from '../../src/index.js';
import { requireRow } from '../../src/lifecycle/record.js';
import { clearTenants, seedTenant } from '../support/tenants.js';
import { bootRowApp, seedLifecycle } from './support/app.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const DELETION: TenantLifecycleState = { operation: { kind: 'delete', done: [], startedAt: '2026-12-01T00:00:00.000Z', reason: 'contract ended' } };
const STARTED = 'the deletion of tenant "acme" started at 2026-12-01T00:00:00.000Z; a deletion is finished, not resumed';

/** A deletion records itself after this call read the row and before its update. */
class DeletionStartsMeanwhile extends TenantStateService {
  protected override async current(id: string): Promise<TenantModel> {
    const row = await super.current(id);
    if (row.state === 'suspended') await seedLifecycle(id, DELETION);
    return row;
  }
}

describe('moving a tenant through TenantStateService while its deletion started', function () {
  this.timeout(30_000);
  let app: TestApp;
  let lifecycle: TenantLifecycle;
  let states: TenantStateService;

  before(async () => {
    app = await bootRowApp();
    lifecycle = await app.resolve(TenantLifecycle);
    states = await app.resolve(TenantStateService);
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await clearTenants();
    (await tenantRegistry()).invalidate();
  });

  async function suspendedForDeletion(): Promise<void> {
    await seedTenant({ id: 'acme' });
    await lifecycle.suspend('acme', 'unpaid');
    await seedLifecycle('acme', DELETION);
  }

  it('refuses to move a suspended tenant whose deletion started to active, and leaves its row as it was', async () => {
    await suspendedForDeletion();
    const before = await requireRow('acme');

    await expect(states.transition('acme', 'active')).to.be.rejectedWith(InvalidOperation, STARTED);
    const after = await requireRow('acme');
    expect(after.state).to.eq('suspended');
    expect(after.suspensionRecord()).to.deep.eq(before.suspensionRecord());
    expect(after.lifecycleRecord()).to.deep.eq(DELETION);
    await expect(admitTenant('acme')).to.be.rejectedWith(TenantUnavailable, 'is suspended');
  });

  it('never activates a provisioning that a deletion took over', async () => {
    await seedTenant({ id: 'acme', state: 'provisioning' });
    await seedLifecycle('acme', DELETION);

    await expect(states.transition('acme', 'active')).to.be.rejectedWith(InvalidOperation, STARTED);
    expect((await requireRow('acme')).state).to.eq('provisioning');
  });

  it('refuses the same move through the model', async () => {
    await suspendedForDeletion();
    const row = await requireRow('acme');

    await expect(row.writeSuspension('active', null)).to.be.rejectedWith(InvalidOperation, STARTED);
    expect(row.state).to.eq('suspended');
    const after = await requireRow('acme');
    expect(after.state).to.eq('suspended');
    expect(after.suspensionRecord()?.reason).to.eq('unpaid');
  });

  it('moves a plainly suspended tenant to active and leaves no suspension record behind', async () => {
    await seedTenant({ id: 'acme' });
    await lifecycle.suspend('acme', 'unpaid');

    expect((await states.transition('acme', 'active')).state).to.eq('active');
    const after = await requireRow('acme');
    expect(after.suspensionRecord()).to.eq(undefined);
    expect((await admitTenant('acme')).state).to.eq('active');
  });

  it('lets a deletion that recorded itself win over a concurrent move to active', async () => {
    for (let round = 0; round < 5; round++) {
      await clearTenants();
      await suspendedForDeletion();

      const [toActive, toDeleting] = await Promise.allSettled([states.transition('acme', 'active'), states.transition('acme', 'deleting')]);
      expect(toActive.status).to.eq('rejected');
      expect(toActive.status === 'rejected' ? toActive.reason : undefined).to.be.instanceOf(InvalidOperation);
      expect(toDeleting.status).to.eq('fulfilled');
      expect((await requireRow('acme')).state).to.eq('deleting');
    }
  });

  it('leaves the row to the winner when the deletion records itself after the move to active read it', async () => {
    await seedTenant({ id: 'acme' });
    await lifecycle.suspend('acme', 'unpaid');

    expect((await new DeletionStartsMeanwhile().transition('acme', 'active')).state).to.eq('active');
    // The deletion lost the race: its own move refuses, and nothing of the tenant is removed.
    await expect(states.transition('acme', 'deleting')).to.be.rejectedWith(InvalidOperation, 'cannot go from active to deleting');
    const after = await requireRow('acme');
    expect(after.state).to.eq('active');
    expect(after.suspensionRecord()).to.eq(undefined);
    await expect(lifecycle.resume('acme')).to.be.rejectedWith(InvalidOperation, 'is active');
  });

  it('keeps the conflict for a tenant another call moved first', async () => {
    await seedTenant({ id: 'acme' });
    await lifecycle.suspend('acme', 'unpaid');
    const both = await Promise.allSettled([states.transition('acme', 'active'), states.transition('acme', 'active')]);
    expect(both.map((r) => r.status).sort()).to.deep.eq(['fulfilled', 'rejected']);
    const lost = both.find((r) => r.status === 'rejected');
    expect(lost?.status === 'rejected' ? lost.reason : undefined).to.be.instanceOf(ConcurrencyConflict);
    expect((await requireRow('acme')).suspensionRecord()).to.eq(undefined);
  });
});
