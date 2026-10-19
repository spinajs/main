import * as chai from 'chai';
import 'mocha';
import { FakeIdentityStore, MemorySessionIssuer } from '@spinajs/authn-testing';

import type { SessionHandle } from '../../src/contracts/session.js';
import { VOUCHED_TYPES, restoreHandle, statusRefusal } from '../../src/support/identity.js';

const expect = chai.expect;

describe('support/identity', () => {
  describe('statusRefusal', () => {
    it('answers the first refusing status flag, or null for an active identity', async () => {
      const store = new FakeIdentityStore();
      const ok = store.add({ login: 'ok' });
      const inactive = store.add({ login: 'inactive', status: { active: false } });
      const banned = store.add({ login: 'banned', status: { banned: true, active: false } });
      const deleted = store.add({ login: 'deleted', status: { deleted: true, banned: true } });
      expect(await statusRefusal(store, ok)).to.eq(null);
      expect(await statusRefusal(store, inactive)).to.eq('inactive');
      expect(await statusRefusal(store, banned)).to.eq('banned');
      expect(await statusRefusal(store, deleted)).to.eq('deleted');
      expect(await statusRefusal(store, { type: 'user', id: 'nobody' })).to.eq('unknown_identity');
    });

    it('skips the store for the vouched types only, so an unknown type fails closed', async () => {
      const store = new FakeIdentityStore();
      expect([...VOUCHED_TYPES].sort()).to.deep.eq(['agent', 'service']);
      expect(await statusRefusal(store, { type: 'service', id: 's1' })).to.eq(null);
      expect(await statusRefusal(store, { type: 'agent', id: 'a1' })).to.eq(null);
      expect(store.calls.status).to.deep.eq([]);
      expect(await statusRefusal(store, { type: 'robot', id: 'r1' })).to.eq('unknown_identity');
    });
  });

  describe('restoreHandle', () => {
    it('restores the session of a handle', async () => {
      const sessions = new MemorySessionIssuer();
      const id = { type: 'user', id: 'u1' };
      const handle = await sessions.issue(id, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
      const stored = await restoreHandle(sessions, handle);
      expect(stored?.identity).to.deep.eq(id);
    });

    it('answers null for a malformed handle or an unknown session', async () => {
      const sessions = new MemorySessionIssuer();
      for (const bad of [null, undefined, 'raw', {}, { id: '' }, { id: 42 }]) {
        expect(await restoreHandle(sessions, bad as unknown as SessionHandle)).to.eq(null);
      }
      expect(await restoreHandle(sessions, { id: 'unknown', state: 'active' })).to.eq(null);
    });
  });
});
