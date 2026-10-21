import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { IdentityAddressVerifier } from '@spinajs/authn/contracts';
import type { AuthnEvent, IdentityRef } from '@spinajs/authn/contracts';

import { UserAccountSink, UserAddressVerifier, UserIdentityStore } from '../../src/index.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from '../support/users-db.js';

const AT = new Date('2026-10-21T09:15:00.000Z');

const redeemed = (identity: IdentityRef): AuthnEvent => ({ type: 'invite.redeem', at: AT, outcome: 'success', identity });

describe('users: the verified address (FEAT-2)', function () {
  this.timeout(30000);

  let store: UserIdentityStore;

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb();
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    store = new UserIdentityStore();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('UserAddressVerifier is the registered IdentityAddressVerifier', async () => {
    expect(await DI.resolve(IdentityAddressVerifier)).to.be.instanceOf(UserAddressVerifier);
  });

  it('a new user reports addressVerified false', async () => {
    const { ref } = await seedUser({ login: 'fresh-address' });
    expect((await store.status(ref)).addressVerified).to.eq(false);
  });

  it('an unknown identity reports addressVerified false', async () => {
    expect((await store.status({ type: 'user', id: '00000000-0000-4000-8000-000000000000' })).addressVerified).to.eq(false);
  });

  it('after markVerified the user reports addressVerified true and EmailVerifiedAt holds the time', async () => {
    const { ref } = await seedUser({ login: 'verified-address' });
    await new UserAddressVerifier().markVerified(ref, AT);

    expect((await store.status(ref)).addressVerified).to.eq(true);
    expect((await storedUser(ref.id)).EmailVerifiedAt?.toMillis()).to.eq(AT.getTime());
  });

  it('a second markVerified keeps the first time', async () => {
    const { ref } = await seedUser({ login: 'verified-twice' });
    const verifier = new UserAddressVerifier();
    await verifier.markVerified(ref, AT);
    await verifier.markVerified(ref, new Date(AT.getTime() + 60_000));

    expect((await storedUser(ref.id)).EmailVerifiedAt?.toMillis()).to.eq(AT.getTime());
  });

  it('markVerified of an unknown or non-user identity changes nothing and does not throw', async () => {
    const verifier = new UserAddressVerifier();
    await verifier.markVerified({ type: 'user', id: '00000000-0000-4000-8000-000000000000' }, AT);
    await verifier.markVerified({ type: 'service', id: 's1' }, AT);
  });

  it('redeeming an invite marks the address verified: the invite mail reached it', async () => {
    const { ref } = await seedUser({ login: 'invited-address', active: false, invitePending: true });
    expect((await store.status(ref)).addressVerified).to.eq(false);

    await (await DI.resolve(UserAccountSink)).publish(redeemed(ref));

    expect(await store.status(ref)).to.deep.include({ active: true, addressVerified: true });
    expect((await storedUser(ref.id)).EmailVerifiedAt?.toMillis()).to.eq(AT.getTime());
  });

  it('a failed invite redemption marks nothing', async () => {
    const { ref } = await seedUser({ login: 'invite-failed', active: false, invitePending: true });
    await (await DI.resolve(UserAccountSink)).publish({ ...redeemed(ref), outcome: 'failure' });
    expect((await store.status(ref)).addressVerified).to.eq(false);
  });
});
