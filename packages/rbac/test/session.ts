import { DI } from '@spinajs/di';
import { MemorySessionStore, SessionProvider, Session } from '../src';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import { TestConfiguration } from './common';

describe('Session provider tests', () => {
  before(async () => {
    DI.register(MemorySessionStore).as(SessionProvider);
    DI.register(TestConfiguration).as(Configuration);

    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  it('should update & restore session', async () => {
    const session = new Session();
    const provider = await DI.resolve(SessionProvider);

    await provider.updateSession(session);

    const restored = await provider.restoreSession(session.SessionId);

    expect(restored instanceof Session).to.be.true;
  });

  it('should delete session', async () => {
    const session = new Session();
    const provider = await DI.resolve(SessionProvider);

    await provider.updateSession(session);
    await provider.deleteSession(session.SessionId);

    const restored = await provider.restoreSession(session.SessionId);

    expect(restored).to.be.null;
  });
});
