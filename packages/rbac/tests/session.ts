import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { MemorySessionProvider, SessionProvider, Session } from '../src';
import { expect } from 'chai';
import { FrameworkConfiguration, Configuration } from '@spinajs/configuration';
import { SpinaJsDefaultLog, LogModule } from '@spinajs/log';

chai.use(chaiAsPromised);

describe('Session provider tests', () => {
  before(async () => {
    DI.register(MemorySessionProvider).as(SessionProvider);
    DI.register(FrameworkConfiguration).as(Configuration);
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
