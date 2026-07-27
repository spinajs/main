// Pure unit test: the controller is constructed directly and its injected
// fields are set by hand, so it does NOT touch the process-wide DI container
// that sibling suites contaminate (they alias UserController / register other
// providers without cleanup).
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import * as cs from 'cookie-signature';

import { ISession, UserSession } from '@spinajs/rbac';
import { UserController } from '../src/controllers/UserController.js';

const COOKIE_SECRET = 'unit-test-secret';

class FakeSessionProvider {
  public Store = new Map<string, ISession>();
  public SavedCount = 0;

  public async restore(id: string): Promise<ISession | null> {
    return this.Store.get(id) ?? null;
  }
  public async save(idOrSession: ISession | string): Promise<void> {
    this.SavedCount++;
    if (typeof idOrSession !== 'string') {
      this.Store.set(idOrSession.SessionId, idOrSession);
    }
  }
}

describe('UserController.refresh', function () {
  this.timeout(15000);

  let controller: UserController;
  let sessionProvider: FakeSessionProvider;

  beforeEach(() => {
    controller = new UserController();
    sessionProvider = new FakeSessionProvider();

    // @Config / @Autoinject make these getter-only; override via defineProperty
    Object.defineProperty(controller, 'CoockieSecret', { value: COOKIE_SECRET, configurable: true, writable: true });
    Object.defineProperty(controller, 'SessionProvider', { value: sessionProvider, configurable: true, writable: true });
  });

  afterEach(() => sinon.restore());

  it('stores the user UUID (not a dehydrated object) back into the session', async () => {
    const session = new UserSession();
    session.Data.set('User', 'stale-value');
    sessionProvider.Store.set(session.SessionId, session);

    const signedSsid = cs.sign(session.SessionId, COOKIE_SECRET);

    const user: any = {
      Uuid: 'user-uuid-123',
      refresh: sinon.stub().resolves(),
      Metadata: { populate: sinon.stub().resolves() },
      dehydrate: () => ({ Uuid: 'user-uuid-123', Login: 'bob' }),
    };

    await controller.refresh(user, signedSsid);

    // must be the plain UUID string so RbacUserFactory can resolve the user
    // on subsequent requests (storing a dehydrated object silently logs the
    // user out on the next request).
    expect(session.Data.get('User')).to.equal('user-uuid-123');
    expect(typeof session.Data.get('User')).to.equal('string');
    expect(sessionProvider.SavedCount).to.be.greaterThan(0);
  });

  it('does not touch the session when the cookie signature is invalid', async () => {
    const session = new UserSession();
    session.Data.set('User', 'original');
    sessionProvider.Store.set(session.SessionId, session);

    const user: any = {
      Uuid: 'user-uuid-123',
      refresh: sinon.stub().resolves(),
      Metadata: { populate: sinon.stub().resolves() },
      dehydrate: () => ({ Uuid: 'user-uuid-123' }),
    };

    // ssid not signed with our secret -> cs.unsign returns false
    await controller.refresh(user, 'not-a-valid-signed-cookie');

    expect(session.Data.get('User')).to.equal('original');
    expect(sessionProvider.SavedCount).to.equal(0);
  });
});
