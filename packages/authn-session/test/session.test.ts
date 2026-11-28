import { DI, Injectable } from '@spinajs/di';
import { expect } from 'chai';
import { DateTime, Settings } from 'luxon';
import { SessionExpirationProvider, SessionProvider } from '../src/contracts.js';
import type { ISession } from '../src/contracts.js';
import { MemorySessionStore, UserSession } from '../src/index.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const alice = { type: 'user', id: 'alice' } as const;

/** A strategy under which a session never expires: both methods give no instant. */
@Injectable(SessionExpirationProvider)
class NeverExpiration extends SessionExpirationProvider {
  public initial(): DateTime | undefined {
    return undefined;
  }

  public renew(): DateTime | undefined {
    return undefined;
  }
}

/** Runs `check` with luxon's clock moved forward, then puts the clock back. */
async function later<T>(minutes: number, check: () => Promise<T>): Promise<T> {
  const at = Date.now() + minutes * 60_000;
  Settings.now = () => at;
  try {
    return await check();
  } finally {
    Settings.now = () => Date.now();
  }
}

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

  describe('touch of a view without Expiration', () => {
    it('an active touch without Expiration under AbsoluteExpiration keeps a finite end (Creation + ttl)', async () => {
      await withSessionConfig({ authn: { session: { service: 'MemorySessionStore', expiration: { service: 'AbsoluteExpiration', ttl: 60 } } } });
      const store = await DI.resolve(MemorySessionStore);
      await store.truncate();

      await store.save(new UserSession({ SessionId: 'k-abs-bare', Subject: alice, State: 'active' }));
      const restored = (await store.restore('k-abs-bare'))!;
      const end = restored.Creation.plus({ minutes: 60 });
      await store.touch(new UserSession({ ...restored, Data: new Map(restored.Data), Expiration: undefined }));

      const after = await store.restore('k-abs-bare');
      expect(after, 'the session is alive before its end').to.not.equal(null);
      expect(after!.Expiration, 'an absent expiration would mean the session never expires').to.not.equal(undefined);
      expect(Math.abs(after!.Expiration!.toMillis() - end.toMillis())).to.be.at.most(1000);
      expect(await later(61, () => store.restore('k-abs-bare')), 'the session is gone after Creation + ttl').to.equal(null);
    });

    it('a never-expiring strategy still renews to no expiration', async () => {
      await withSessionConfig({ authn: { session: { service: 'MemorySessionStore', expiration: { service: NeverExpiration.name, ttl: 60 } } } }, [NeverExpiration]);
      const store = await DI.resolve(MemorySessionStore);
      await store.truncate();

      await store.save(new UserSession({ SessionId: 'k-never', Subject: alice, State: 'active' }));
      const restored = (await store.restore('k-never'))!;
      expect(restored.Expiration).to.equal(undefined);
      const view = new UserSession({ ...restored, Data: new Map(restored.Data), Expiration: undefined });
      view.Data.set('Ip', '203.0.113.4');
      await store.touch(view);

      const after = (await store.restore('k-never'))!;
      expect(after.Expiration).to.equal(undefined);
      expect(after.Data.get('Ip')).to.equal('203.0.113.4');
      expect(await later(60 * 24 * 365, () => store.restore('k-never')), 'a row without an expiration never expires').to.not.equal(null);
    });
  });
});
