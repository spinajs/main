import { DI } from '@spinajs/di';
import { expect } from 'chai';
import { SessionProvider } from '../src/contracts.js';
import { UserSession } from '../src/index.js';
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
});
