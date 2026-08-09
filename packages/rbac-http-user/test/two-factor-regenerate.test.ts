// Pure unit test: the controller is constructed directly and its injected
// fields are set by hand, so it does not touch the process-wide DI container
// that sibling suites contaminate.
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { ISession, UserSession } from '@spinajs/rbac';
import { Ok } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { TwoFactorAuthController } from '../src/controllers/TwoFactorAuthController.js';
import { SessionCookieFactory } from '../src/services/SessionCookies.js';
import { TokenDto } from '../src/dto/token-dto.js';

class FakeSessionProvider {
  public Store = new Map<string, ISession>();
  public Saved: ISession[] = [];
  public Deleted: string[] = [];

  public async delete(id: string): Promise<void> {
    this.Deleted.push(id);
    this.Store.delete(id);
  }
  public async save(session: ISession): Promise<void> {
    this.Saved.push(session);
    this.Store.set(session.SessionId, session);
  }
}

describe('TwoFactorAuthController.verifyToken — session regeneration on 2FA authorize', function () {
  this.timeout(15000);

  let controller: TwoFactorAuthController;
  let sessionProvider: FakeSessionProvider;

  const buildUser = () => ({
    Uuid: 'user-uuid',
    Role: [] as string[],
    Metadata: {} as Record<string, unknown>,
    dehydrateWithRelations: () => ({ Uuid: 'user-uuid' }),
  });

  const buildSession = (): ISession => {
    const s = new UserSession();
    s.Data.set('Authorized', false);
    s.Data.set('TwoFactorAuth', true);
    return s;
  };

  beforeEach(() => {
    controller = new TwoFactorAuthController();
    sessionProvider = new FakeSessionProvider();

    Object.defineProperty(controller, 'SessionProvider', { value: sessionProvider, configurable: true, writable: true });
    Object.defineProperty(controller, 'AC', { value: { getGrants: () => ({}) }, configurable: true, writable: true });

    // the cookie factory reads its overrides from config; hand it an empty set
    const cookies = new SessionCookieFactory();
    Object.defineProperty(cookies, 'SessionCookieConfig', { value: {}, configurable: true, writable: true });
    Object.defineProperty(controller, 'SessionCookies', { value: cookies, configurable: true, writable: true });

    // Stub the protected 2FA verification wrapper so no TOTP/DB is needed.
    sinon.stub(controller as any, 'verifyTwoFactorToken').resolves();
  });

  afterEach(() => sinon.restore());

  it('regenerates the session: new id issued, old id deleted, Authorized set, ssid cookie reset', async () => {
    // Activation is exercised on its own below; stub it out here so this test
    // stays focused on session regeneration.
    sinon.stub(controller as any, 'activateEnrolment').resolves();

    const user = buildUser();
    const session = buildSession();
    const oldId = session.SessionId;

    const result = await controller.verifyToken(user as any, new TokenDto({ Token: '123456' }), session);

    expect(result).to.be.instanceOf(Ok);

    // authorized + 2fa flag cleared on the (regenerated) session data
    expect(session.Data.get('Authorized')).to.equal(true);
    expect(session.Data.has('TwoFactorAuth')).to.be.false;

    // old session invalidated, a fresh one persisted with a different id
    expect(sessionProvider.Deleted).to.include(oldId);
    expect(sessionProvider.Saved).to.have.lengthOf(1);
    const regenerated = sessionProvider.Saved[0];
    expect(regenerated.SessionId).to.not.equal(oldId);
    expect(regenerated.Data.get('Authorized')).to.equal(true);

    // ssid cookie reset to the regenerated id
    const cookies = (result as any).options?.Coockies ?? [];
    expect(cookies).to.have.lengthOf(1);
    expect(cookies[0].Name).to.equal('ssid');
    expect(cookies[0].Value).to.equal(regenerated.SessionId);
  });

  it('activates a pending enrolment before authorizing the session', async () => {
    const activateStub = sinon.stub(controller as any, 'activateEnrolment').resolves();
    const user = { ...buildUser(), Metadata: { '2fa:token': 'STOREDSECRET' } };

    await controller.verifyToken(user as any, new TokenDto({ Token: '123456' }), buildSession());

    sinon.assert.calledOnce(activateStub);
  });

  it('does not re-activate an account that already has 2fa on', async () => {
    const activateStub = sinon.stub(controller as any, 'activateEnrolment').resolves();
    const user = { ...buildUser(), Metadata: { '2fa:token': 'STOREDSECRET', '2fa:enabled': true } };

    await controller.verifyToken(user as any, new TokenDto({ Token: '123456' }), buildSession());

    sinon.assert.notCalled(activateStub);
  });
});

describe('TwoFactorAuthController.setup2fa — system-wide switch', function () {
  this.timeout(15000);

  it('refuses to start enrolment when 2fa is switched off system-wide', async () => {
    const controller = new TwoFactorAuthController();
    Object.defineProperty(controller, 'TwoFactorConfig', { value: { enabled: false }, configurable: true, writable: true });
    const enrolStub = sinon.stub(controller as any, 'enrol').resolves('otpauth://totp/Spinajs:me?secret=ABC');

    const user = { Uuid: 'user-uuid', Metadata: {} as Record<string, unknown> };

    let thrown: any = null;
    try {
      await controller.setup2fa(user as any);
    } catch (err) {
      thrown = err;
    }

    expect(thrown, 'must be a 403, not a 500').to.be.instanceOf(Forbidden);
    expect(thrown.error?.code).to.equal('E_2FA_SYSTEM_DISABLED');
    sinon.assert.notCalled(enrolStub);
  });
});
