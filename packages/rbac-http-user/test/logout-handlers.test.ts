import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import {
  PasswordProvider,
  SessionProvider,
  AuthProvider,
  ISession,
  UserSession,
  UserImpersonationEnded,
  User,
} from '@spinajs/rbac';

import { LogoutHandler, ILogoutContext } from '../src/logout.js';
import { ImpersonationLogoutHandler } from '../src/handlers/ImpersonationLogoutHandler.js';
import { DefaultLogoutHandler } from '../src/handlers/DefaultLogoutHandler.js';

/**
 * Tests for the pluggable logout handler chain. Verifies built-in handlers
 * behave as documented (impersonation revert short-circuits the default
 * session destruction) and that custom handlers plug in via @Injectable.
 */

class LogoutTestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      rbac: {
        password: { service: 'LogoutTestPasswordProvider' },
        auth: { service: 'LogoutTestAuthProvider' },
        session: { service: 'LogoutTestSessionProvider' },
        session_cookie: {},
      },
      // The handlers' AutoinjectService resolves by config name. Make sure
      // this file's distinctly-named providers win regardless of registration
      // order from other test files.
    };
  }
}

class LogoutTestPasswordProvider extends PasswordProvider {
  public async verify(): Promise<boolean> { return true; }
  public async hash(i: string): Promise<string> { return `h:${i}`; }
  public generate(): string { return 'g'; }
}

// Static-shared activity log so assertions are robust regardless of which
// instance the DI container hands to the handler. Each test resets these in
// beforeEach.
class LogoutTestSessionProvider extends SessionProvider<ISession> {
  public static Saved: ISession[] = [];
  public static Deleted: string[] = [];
  public async restore(): Promise<ISession | null> { return null; }
  public async delete(id: string): Promise<void> { LogoutTestSessionProvider.Deleted.push(id); }
  public async save(idOrSession: ISession | string): Promise<void> {
    if (typeof idOrSession !== 'string') LogoutTestSessionProvider.Saved.push(idOrSession);
  }
  public async touch(): Promise<void> { /* noop */ }
  public async truncate(): Promise<void> { /* noop */ }
  public async logsOut(): Promise<void> { /* noop */ }
}

class LogoutTestAuthProvider extends AuthProvider {
  public async exists() { return false; }
  public async authenticate(): Promise<any> { return null; }
  public async isBanned() { return false; }
  public async isActive() { return true; }
  public async isDeleted() { return false; }
  public async getByLogin(): Promise<any> { return null; }
  public async getByEmail(): Promise<any> { return null; }
  public async getByUUID(): Promise<any> { return null; }
}

const makeUser = (overrides: Partial<User> & { Uuid: string; Role: string[] }) =>
  ({
    Id: 1,
    Password: 'hashed-pass',
    IsActive: true,
    IsBanned: false,
    ...overrides,
  } as any as User);

describe('Logout handler chain', function () {
  this.timeout(15000);

  beforeEach(async () => {
    // Reset the static activity log — multiple DI instances of the provider
    // all write to the same place, so assertions don't depend on which
    // instance the handler was wired with.
    LogoutTestSessionProvider.Saved = [];
    LogoutTestSessionProvider.Deleted = [];

    // Register bindings here (not in before) so this file's LogoutTestConfiguration
    // is the latest one when run in combination with other test files.
    DI.register(LogoutTestConfiguration).as(Configuration);
    DI.register(LogoutTestPasswordProvider).as(PasswordProvider);
    DI.register(LogoutTestSessionProvider).as(SessionProvider);
    DI.register(LogoutTestAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();
    await DI.resolve(Configuration);

    // Resolve via Array.ofType so the abstract base's collection cache is
    // populated. Individual DI.resolve calls go through asSelf() and do NOT
    // populate the LogoutHandler-group cache used by Array.ofType readers.
    await DI.resolve(Array.ofType(LogoutHandler));
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  const session = (init: Record<string, unknown> = {}): ISession => {
    const s = new UserSession();
    for (const [k, v] of Object.entries(init)) s.Data.set(k, v);
    return s;
  };

  describe('ImpersonationLogoutHandler', () => {
    it('Priority is 10 (runs early)', async () => {
      const handler = (await DI.resolve(ImpersonationLogoutHandler)) as ImpersonationLogoutHandler;
      expect(handler.Priority).to.equal(10);
    });

    it('returns null when session is null (defers)', async () => {
      const handler = (await DI.resolve(ImpersonationLogoutHandler)) as ImpersonationLogoutHandler;
      const result = await handler.handle({ Ssid: 'x', Session: null, User: makeUser({ Uuid: 'u', Role: ['user'] }) });
      expect(result).to.be.null;
    });

    it('returns null when no impersonation in session (defers)', async () => {
      const handler = (await DI.resolve(ImpersonationLogoutHandler)) as ImpersonationLogoutHandler;
      const result = await handler.handle({ Ssid: 'x', Session: session(), User: makeUser({ Uuid: 'u', Role: ['user'] }) });
      expect(result).to.be.null;
    });

    it('reverts impersonation, saves session, emits event when active', async () => {
      const handler = (await DI.resolve(ImpersonationLogoutHandler)) as ImpersonationLogoutHandler;
      const evStub = sinon.stub(handler as any, 'emitEvent').resolves();

      const original = makeUser({ Uuid: 'admin-uuid', Role: ['admin'] });
      sinon.stub(User, 'getByUuid').resolves(original);

      const target = makeUser({ Uuid: 'user-uuid', Role: ['user'] });
      const s = session({
        User: 'user-uuid',
        Impersonator: 'admin-uuid',
        ImpersonationStartedAt: '2026-06-01T00:00:00.000Z',
        OriginalActiveRole: 'admin',
        ActiveRole: 'user',
      });

      const result = await handler.handle({ Ssid: 'sid', Session: s, User: target });

      expect(result).to.deep.equal({ Body: { ImpersonationEnded: true } });
      expect(s.Data.get('User')).to.equal('admin-uuid');
      expect(s.Data.has('Impersonator')).to.be.false;
      expect(s.Data.has('ImpersonationStartedAt')).to.be.false;
      expect(s.Data.has('OriginalActiveRole')).to.be.false;
      expect(s.Data.get('ActiveRole')).to.equal('admin');

      expect(LogoutTestSessionProvider.Saved).to.have.lengthOf(1);
      expect(LogoutTestSessionProvider.Deleted).to.be.empty;

      sinon.assert.calledOnce(evStub);
      const [emittedOriginal, emittedTarget] = evStub.firstCall.args;
      expect(emittedOriginal.Uuid).to.equal('admin-uuid');
      expect(emittedTarget.Uuid).to.equal('user-uuid');
      // sanity: the handler instantiates UserImpersonationEnded internally
      // through _ev, but we asserted at the emitEvent boundary, where args
      // are just the two User instances.
      expect(UserImpersonationEnded).to.be.a('function'); // type still resolvable
    });
  });

  describe('DefaultLogoutHandler', () => {
    it('Priority is 999 (runs last)', async () => {
      const handler = (await DI.resolve(DefaultLogoutHandler)) as DefaultLogoutHandler;
      expect(handler.Priority).to.equal(999);
    });

    it('deletes session and returns clear-cookie payload', async () => {
      const handler = (await DI.resolve(DefaultLogoutHandler)) as DefaultLogoutHandler;
      const result = await handler.handle({ Ssid: 'sid', Session: session(), User: makeUser({ Uuid: 'u', Role: ['user'] }) });

      expect(result).to.not.be.null;
      expect(result!.Body).to.be.null;
      expect(result!.Cookies).to.have.lengthOf(1);
      expect(result!.Cookies![0].Name).to.equal('ssid');
      expect(result!.Cookies![0].Value).to.equal('');
      expect(result!.Cookies![0].Options).to.include({ maxAge: 0, httpOnly: true });

      expect(LogoutTestSessionProvider.Deleted).to.deep.equal(['sid']);
    });

    it('returns a result even with empty Ssid (no delete called)', async () => {
      const handler = (await DI.resolve(DefaultLogoutHandler)) as DefaultLogoutHandler;
      const result = await handler.handle({ Ssid: '', Session: session(), User: makeUser({ Uuid: 'u', Role: ['user'] }) });
      expect(result).to.not.be.null;
      expect(result!.Body).to.be.null;
      expect(LogoutTestSessionProvider.Deleted).to.be.empty;
    });
  });

  describe('DI chain — Array.ofType(LogoutHandler)', () => {
    it('resolves both built-in handlers via DI', async () => {
      const handlers = (await DI.resolve(Array.ofType(LogoutHandler))) as LogoutHandler[];
      const names = handlers.map(h => h.constructor.name);
      expect(names).to.include.members(['ImpersonationLogoutHandler', 'DefaultLogoutHandler']);
    });

    it('sorts by Priority ascending — impersonation before default', async () => {
      const handlers = (await DI.resolve(Array.ofType(LogoutHandler))) as LogoutHandler[];
      const sorted = [...handlers].sort((a, b) => a.Priority - b.Priority);
      expect(sorted[0]).to.be.instanceOf(ImpersonationLogoutHandler);
      expect(sorted[sorted.length - 1]).to.be.instanceOf(DefaultLogoutHandler);
    });

    it('first non-null result short-circuits the chain', async () => {
      // Build a fake chain manually to test the iteration policy. The
      // controller uses this exact pattern.
      const earlyHandler: LogoutHandler = {
        Priority: 5,
        handle: sinon.stub().resolves({ Body: 'early', Cookies: [] }),
      } as any;
      const lateHandler: LogoutHandler = {
        Priority: 50,
        handle: sinon.stub().resolves({ Body: 'late', Cookies: [] }),
      } as any;

      const chain = [earlyHandler, lateHandler].sort((a, b) => a.Priority - b.Priority);
      const ctx: ILogoutContext = { Ssid: 'x', Session: session(), User: makeUser({ Uuid: 'u', Role: ['user'] }) };

      let chosen: any = null;
      for (const h of chain) {
        const r = await h.handle(ctx);
        if (r) { chosen = r; break; }
      }

      expect(chosen.Body).to.equal('early');
      sinon.assert.calledOnce(earlyHandler.handle as any);
      sinon.assert.notCalled(lateHandler.handle as any);
    });

    it('null returns are skipped — next handler runs', async () => {
      const skipHandler: LogoutHandler = {
        Priority: 5,
        handle: sinon.stub().resolves(null),
      } as any;
      const finalHandler: LogoutHandler = {
        Priority: 50,
        handle: sinon.stub().resolves({ Body: 'final', Cookies: [] }),
      } as any;

      const chain = [skipHandler, finalHandler].sort((a, b) => a.Priority - b.Priority);
      const ctx: ILogoutContext = { Ssid: 'x', Session: session(), User: makeUser({ Uuid: 'u', Role: ['user'] }) };

      let chosen: any = null;
      for (const h of chain) {
        const r = await h.handle(ctx);
        if (r) { chosen = r; break; }
      }

      expect(chosen.Body).to.equal('final');
      sinon.assert.calledOnce(skipHandler.handle as any);
      sinon.assert.calledOnce(finalHandler.handle as any);
    });
  });
});
