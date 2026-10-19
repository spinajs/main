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
});
