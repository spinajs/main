import { DI } from '@spinajs/di';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { SessionProvider } from '../src/contracts.js';
import type { ISession } from '../src/contracts.js';
import { MemorySessionStore, UserSession } from '../src/index.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const alice = { type: 'user', id: 'alice' } as const;

describe('Session provider tests', () => {
  beforeEach(async () => {
    // The SessionProvider base autoinjects its expiration strategy (authn.session.expiration).
    await withSessionConfig({ authn: { session: { service: 'MemorySessionStore' } } });
  });

  afterEach(() => {
    uncacheOwned();
  });

  it('should update & restore session', async () => {
    const session = new UserSession({ SessionId: 'k-restore', Subject: alice, State: 'active' });
    const provider = await DI.resolve(SessionProvider);

    await provider.save(session);

    const restored = await provider.restore(session.SessionId);

    expect(restored instanceof UserSession).to.be.true;
  });

  it('should delete session', async () => {
    const session = new UserSession({ SessionId: 'k-delete', Subject: alice, State: 'active' });
    const provider = await DI.resolve(SessionProvider);

    await provider.save(session);
    await provider.delete(session.SessionId);

    const restored = await provider.restore(session.SessionId);

    expect(restored).to.be.null;
  });

  it('drops expired rows that are never restored again once enough sessions are saved', async () => {
    const store = await DI.resolve(MemorySessionStore);
    await store.truncate();
    const rows = () => (store as unknown as { Sessions: Map<string, ISession> }).Sessions;

    await store.save(new UserSession({ SessionId: 'k-abandoned', Subject: alice, State: 'active', Expiration: DateTime.now().minus({ minutes: 1 }) }));
    await store.save(new UserSession({ SessionId: 'k-live', Subject: alice, State: 'active' }));
    for (let i = 0; i < 256; i++) {
      await store.save(new UserSession({ SessionId: `k-fill-${i}`, Subject: alice, State: 'active' }));
    }

    expect(rows().has('k-abandoned')).to.equal(false);
    expect(rows().has('k-live')).to.equal(true);
    expect(await store.listBySubject(alice)).to.have.length(257);
  });

  describe('touch of a view that is not the stored object', () => {
    const carol = { type: 'user', id: 'carol' } as const;
    const mallory = { type: 'user', id: 'mallory' } as const;

    it('touch with an active view never activates a row stored as pending', async () => {
      const store = await DI.resolve(MemorySessionStore);
      await store.truncate();
      const fixed = DateTime.now().plus({ minutes: 5 });
      await store.save(new UserSession({ SessionId: 'k-pending', Subject: alice, State: 'pending', Expiration: fixed }));

      const view = new UserSession({ SessionId: 'k-pending', Subject: alice, State: 'active', Expiration: fixed });
      expect(await store.touch(view)).to.equal(false);

      const after = (await store.restore('k-pending'))!;
      expect(after.State, 'a pre-MFA session must never become active through touch (SR-07)').to.equal('pending');
      expect(after.Expiration!.toMillis()).to.equal(fixed.toMillis());
    });

    it('touch keeps the stored Subject and Impersonator', async () => {
      const store = await DI.resolve(MemorySessionStore);
      await store.truncate();
      const creation = DateTime.now().minus({ minutes: 1 });
      await store.save(new UserSession({ SessionId: 'k-identity', Subject: alice, Impersonator: carol, State: 'active', Creation: creation, ExternalKey: 'ext-1' }));

      await store.touch(new UserSession({ SessionId: 'k-identity', Subject: mallory, State: 'active', ExternalKey: 'ext-2' }));

      const after = (await store.restore('k-identity'))!;
      expect(after.Subject).to.deep.equal(alice);
      expect(after.Impersonator).to.deep.equal(carol);
      expect(after.Creation.toMillis()).to.equal(creation.toMillis());
      expect(after.ExternalKey).to.equal('ext-1');
    });

    it('touch of a view in the stored State writes its Data and the renewed Expiration', async () => {
      const store = await DI.resolve(MemorySessionStore);
      await store.truncate();
      const soon = DateTime.now().plus({ minutes: 1 });
      await store.save(new UserSession({ SessionId: 'k-write', Subject: alice, State: 'active', Expiration: soon }));

      const view = new UserSession({ SessionId: 'k-write', Subject: alice, State: 'active', Expiration: soon });
      view.Data.set('Ip', '203.0.113.7');
      expect(await store.touch(view)).to.equal(true);

      const after = (await store.restore('k-write'))!;
      expect(after.Data.get('Ip')).to.equal('203.0.113.7');
      expect(after.Expiration!.toMillis()).to.equal(view.Expiration!.toMillis());
      expect(after.Expiration!.toMillis()).to.be.greaterThan(soon.toMillis());
    });
  });
});
