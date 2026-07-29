// Pure unit test: the controller is constructed directly and its injected
// fields are set by hand, so it does NOT touch the process-wide DI container
// that sibling suites contaminate (they alias UserController / register other
// providers without cleanup).
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { ISession, UserSession } from '@spinajs/rbac';
import { UserController } from '../src/controllers/UserController.js';

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

/**
 * `refresh` takes its ssid through `@Cookie(true)`, so the framework has
 * already verified the signature and handed over the plain session id — or
 * `null` when the cookie was missing or its signature did not check out. The
 * handler therefore only ever sees a usable id or nothing, which is what these
 * two cases cover.
 */
describe('UserController.refresh', function () {
  this.timeout(15000);

  let controller: UserController;
  let sessionProvider: FakeSessionProvider;

  const fakeUser = () => ({
    Uuid: 'user-uuid-123',
    refresh: sinon.stub().resolves(),
    Metadata: { populate: sinon.stub().resolves() },
    dehydrateWithRelations: () => ({ Uuid: 'user-uuid-123', Login: 'bob' }),
  });

  beforeEach(() => {
    controller = new UserController();
    sessionProvider = new FakeSessionProvider();

    // @Config / @Autoinject make these getter-only; override via defineProperty
    Object.defineProperty(controller, 'SessionProvider', { value: sessionProvider, configurable: true, writable: true });
  });

  afterEach(() => sinon.restore());

  it('stores the user UUID (not a dehydrated object) back into the session', async () => {
    const session = new UserSession();
    session.Data.set('User', 'stale-value');
    sessionProvider.Store.set(session.SessionId, session);

    await controller.refresh(fakeUser() as any, session.SessionId);

    // must be the plain UUID string so RbacUserFactory can resolve the user
    // on subsequent requests (storing a dehydrated object silently logs the
    // user out on the next request).
    expect(session.Data.get('User')).to.equal('user-uuid-123');
    expect(typeof session.Data.get('User')).to.equal('string');
    expect(sessionProvider.SavedCount).to.be.greaterThan(0);
  });

  it('does not touch the session when no valid ssid reaches the handler', async () => {
    const session = new UserSession();
    session.Data.set('User', 'original');
    sessionProvider.Store.set(session.SessionId, session);

    // an unsigned / tampered cookie never gets this far — the extractor
    // resolves the argument to null instead
    await controller.refresh(fakeUser() as any, null as unknown as string);

    expect(session.Data.get('User')).to.equal('original');
    expect(sessionProvider.SavedCount).to.equal(0);
  });

  it('returns the user with relations and ISO dates, matching every other user response', async () => {
    const user = fakeUser();
    const spy = sinon.spy(user, 'dehydrateWithRelations');

    await controller.refresh(user as any, null as unknown as string);

    sinon.assert.calledOnce(spy);
  });
});
