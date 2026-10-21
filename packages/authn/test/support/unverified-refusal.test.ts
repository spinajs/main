import * as chai from 'chai';
import 'mocha';
import { FakeIdentityStore } from '@spinajs/authn-testing';

import { statusRefusal } from '../../src/support/identity.js';

const expect = chai.expect;

describe('support/identity: authn.login.requireVerifiedAddress (FEAT-2)', () => {
  function stores() {
    const store = new FakeIdentityStore();
    return {
      store,
      unverified: store.add({ login: 'unverified', status: { addressVerified: false } }),
      verified: store.add({ login: 'verified', status: { addressVerified: true } }),
      untracked: store.add({ login: 'untracked' }),
    };
  }

  it('with the switch on, an existing active identity whose address is unverified is refused with unverified_address', async () => {
    const { store, unverified } = stores();
    expect(await store.status(unverified)).to.deep.include({ exists: true, active: true, addressVerified: false });
    expect(await statusRefusal(store, unverified, { requireVerifiedAddress: true })).to.eq('unverified_address');
  });

  it('with the switch on, a verified address and one the store does not track (addressVerified undefined) are not refused', async () => {
    const { store, verified, untracked } = stores();
    expect((await store.status(untracked)).addressVerified).to.eq(undefined);
    expect(await statusRefusal(store, verified, { requireVerifiedAddress: true })).to.eq(null);
    expect(await statusRefusal(store, untracked, { requireVerifiedAddress: true })).to.eq(null);
  });

  it('with the switch off or not given, nothing is refused for its address', async () => {
    const { store, unverified, verified, untracked } = stores();
    for (const id of [unverified, verified, untracked]) {
      expect(await statusRefusal(store, id, { requireVerifiedAddress: false })).to.eq(null);
      expect(await statusRefusal(store, id)).to.eq(null);
    }
  });

  it('a status refusal outranks the address: deleted, banned and inactive keep their own reason', async () => {
    const store = new FakeIdentityStore();
    const inactive = store.add({ login: 'inactive', status: { active: false, addressVerified: false } });
    const banned = store.add({ login: 'banned', status: { banned: true, addressVerified: false } });
    expect(await statusRefusal(store, inactive, { requireVerifiedAddress: true })).to.eq('inactive');
    expect(await statusRefusal(store, banned, { requireVerifiedAddress: true })).to.eq('banned');
  });

  it('a vouched type is never asked, so its address is never refused', async () => {
    const store = new FakeIdentityStore();
    expect(await statusRefusal(store, { type: 'service', id: 's1' }, { requireVerifiedAddress: true })).to.eq(null);
    expect(store.calls.status).to.deep.eq([]);
  });
});
