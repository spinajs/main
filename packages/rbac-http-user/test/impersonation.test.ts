import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AccessControl } from 'accesscontrol';

import {
  PasswordProvider,
  SessionProvider,
  AuthProvider,
  ISession,
  UserSession,
  UserImpersonationStarted,
  UserImpersonationEnded,
  User,
} from '@spinajs/rbac';

import { ImpersonationController } from '../src/controllers/ImpersonationController.js';
import { ImpersonateDto } from '../src/dto/impersonate-dto.js';

import { Ok, BadRequestResponse, Unauthorized, ForbiddenResponse, Conflict, NotFound } from '@spinajs/http';

/**
 * DI-driven tests for ImpersonationController. Real Configuration / DI /
 * AccessControl / Providers (mock implementations) are wired through the
 * container. Target / original lookups (`loadTarget`, `loadOriginal`) are
 * stubbed since the controller's behavior under various target shapes is the
 * thing under test — actual DB persistence is exercised in the rbac package.
 */

class TestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      rbac: {
        password: { service: 'TestPasswordProvider' },
        auth: { service: 'TestAuthProvider' },
        session: { service: 'TestSessionProvider' },
        roleSwitch: { requirePassword: [] as string[] },
        impersonation: {
          requirePassword: true,
          protectedRoles: ['system'],
        },
        grants: {
          system: { Anything: { 'create:any': ['*'], 'read:any': ['*'] } },
          admin: {
            users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
            'user:impersonate': { 'create:any': ['*'] },
          },
          user: { users: { 'read:own': ['*'], 'update:own': ['*'] } },
        },
      },
    };
  }
}

class TestPasswordProvider extends PasswordProvider {
  public async verify(): Promise<boolean> {
    return true;
  }
  public async hash(input: string): Promise<string> {
    return `hashed:${input}`;
  }
  public generate(): string {
    return 'gen';
  }
}

class TestSessionProvider extends SessionProvider<ISession> {
  public Saved: ISession[] = [];
  public async restore(): Promise<ISession | null> {
    return null;
  }
  public async delete(): Promise<void> {
    /* noop */
  }
  public async save(idOrSession: ISession | string): Promise<void> {
    if (typeof idOrSession !== 'string') this.Saved.push(idOrSession);
  }
  public async touch(): Promise<void> {
    /* noop */
  }
  public async truncate(): Promise<void> {
    /* noop */
  }
  public async logsOut(): Promise<void> {
    /* noop */
  }
}

class TestAuthProvider extends AuthProvider {
  public async exists(): Promise<boolean> {
    return false;
  }
  public async authenticate(): Promise<any> {
    return null;
  }
  public async isBanned(): Promise<boolean> {
    return false;
  }
  public async isActive(): Promise<boolean> {
    return true;
  }
  public async isDeleted(): Promise<boolean> {
    return false;
  }
  public async getByLogin(): Promise<any> {
    return null;
  }
  public async getByEmail(): Promise<any> {
    return null;
  }
  public async getByUUID(): Promise<any> {
    return null;
  }
}

/** Minimal User-shaped object — bypasses DB. The controller never calls
 * Model methods on these directly other than dehydrateWithRelations(), which
 * we stub through `dehydrateWithRelations` on the fake. */
const makeUser = (overrides: Partial<User> & { Uuid: string; Role: string[] }) =>
  ({
    Id: 1,
    Password: 'hashed-pass',
    IsActive: true,
    IsBanned: false,
    ...overrides,
    dehydrateWithRelations: () => ({ Uuid: overrides.Uuid, Role: overrides.Role }),
  } as any as User);

describe('ImpersonationController', function () {
  this.timeout(15000);

  let controller: ImpersonationController;
  let passwordProvider: TestPasswordProvider;
  let sessionProvider: TestSessionProvider;
  let evStub: sinon.SinonStub;

  before(() => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(TestPasswordProvider).as(PasswordProvider);
    DI.register(TestSessionProvider).as(SessionProvider);
    DI.register(TestAuthProvider).as(AuthProvider);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();

    await DI.resolve(Configuration);

    // Cross-file test isolation: when this suite runs after another that
    // registered a TestConfiguration with different grants, AccessControl
    // may have been seeded with the wrong shape. Reset grants explicitly so
    // this suite's expectations hold regardless of run order.
    const ac = DI.get<AccessControl>('AccessControl')!;
    ac.setGrants({
      system: { Anything: { 'create:any': ['*'], 'read:any': ['*'] } },
      admin: {
        users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
        'user:impersonate': { 'create:any': ['*'] },
      },
      user: { users: { 'read:own': ['*'], 'update:own': ['*'] } },
    });

    controller = (await DI.resolve(ImpersonationController)) as ImpersonationController;
    passwordProvider = DI.get(PasswordProvider) as TestPasswordProvider;
    sessionProvider = DI.get(SessionProvider) as TestSessionProvider;

    // Intercept event emission so tests can assert it without a real queue.
    // Stubs the controller's protected emit wrapper.
    evStub = sinon.stub(controller as any, 'emitEvent').resolves();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  const data = (r: any) => (r as any).responseData;

  const session = (init: Record<string, unknown> = {}): ISession => {
    const s = new UserSession();
    for (const [k, v] of Object.entries(init)) s.Data.set(k, v);
    return s;
  };

  const adminCaller = () =>
    makeUser({ Uuid: 'admin-uuid', Role: ['admin'], Password: 'hashed-admin' });
  const userTarget = () =>
    makeUser({ Uuid: 'user-uuid', Role: ['user'] });

  // Use defineProperty since @Config produces a non-writable getter on the
  // prototype.
  const setRequirePassword = (v: boolean) =>
    Object.defineProperty(controller, 'RequirePassword', {
      value: v,
      writable: true,
      configurable: true,
    });
  const setProtectedRoles = (v: string[]) =>
    Object.defineProperty(controller, 'ProtectedRoles', {
      value: v,
      writable: true,
      configurable: true,
    });

  describe('start', () => {
    it('happy path: admin impersonates user with correct password', async () => {
      const caller = adminCaller();
      const target = userTarget();
      sinon.stub(controller as any, 'loadTarget').resolves(target);
      setRequirePassword(true);

      const dto = new ImpersonateDto({ TargetUuid: target.Uuid, Password: 'pwd' });
      const s = session({ ActiveRole: 'admin' });

      const result = await controller.start(caller, s, dto);

      expect(result).to.be.instanceOf(Ok);
      const body = data(result);
      expect(body.User.Uuid).to.equal('user-uuid');
      expect(body.Impersonator.Uuid).to.equal('admin-uuid');
      expect(body.ActiveRole).to.equal('user');
      expect(body.User.Role).to.deep.equal(['user']);
      expect(body.StartedAt).to.be.a('string');

      // Session state mutated correctly
      expect(s.Data.get('User')).to.equal('user-uuid');
      expect(s.Data.get('Impersonator')).to.equal('admin-uuid');
      expect(s.Data.get('OriginalActiveRole')).to.equal('admin');
      expect(s.Data.get('ActiveRole')).to.equal('user');
      expect(s.Data.get('ImpersonationStartedAt')).to.equal(body.StartedAt);

      expect(sessionProvider.Saved).to.have.lengthOf(1);

      // UserImpersonationStarted event emitted exactly once with the right pair
      sinon.assert.calledOnce(evStub);
      const event = evStub.firstCall.args[0];
      expect(event).to.be.instanceOf(UserImpersonationStarted);
      expect((event as UserImpersonationStarted).UserUUID).to.equal('admin-uuid');
      expect((event as UserImpersonationStarted).TargetUUID).to.equal('user-uuid');
    });

    it('409 Conflict when an impersonation is already active', async () => {
      const caller = adminCaller();
      const dto = new ImpersonateDto({ TargetUuid: 'other-uuid', Password: 'pwd' });
      const s = session({ Impersonator: 'admin-uuid', User: 'other' });

      const result = await controller.start(caller, s, dto);
      expect(result).to.be.instanceOf(Conflict);
      expect(data(result).error.code).to.equal('E_IMPERSONATION_ACTIVE');
      sinon.assert.notCalled(evStub);
    });

    it('400 BadRequest when impersonating self', async () => {
      const caller = adminCaller();
      const dto = new ImpersonateDto({ TargetUuid: caller.Uuid, Password: 'pwd' });

      const result = await controller.start(caller, session(), dto);
      expect(result).to.be.instanceOf(BadRequestResponse);
      expect(data(result).error.code).to.equal('E_SELF_IMPERSONATION');
      sinon.assert.notCalled(evStub);
    });

    it('403 Forbidden when caller lacks user:impersonate createAny', async () => {
      const caller = makeUser({ Uuid: 'plain-user-uuid', Role: ['user'] });
      const dto = new ImpersonateDto({ TargetUuid: 'someone', Password: 'pwd' });

      const result = await controller.start(caller, session({ ActiveRole: 'user' }), dto);
      expect(result).to.be.instanceOf(ForbiddenResponse);
      expect(data(result).error.code).to.equal('E_IMPERSONATE_FORBIDDEN');
      sinon.assert.notCalled(evStub);
    });

    it('404 NotFound when loadTarget returns undefined', async () => {
      const caller = adminCaller();
      sinon.stub(controller as any, 'loadTarget').resolves(undefined);

      const dto = new ImpersonateDto({ TargetUuid: 'ghost-uuid', Password: 'pwd' });
      const result = await controller.start(caller, session({ ActiveRole: 'admin' }), dto);

      expect(result).to.be.instanceOf(NotFound);
      expect(data(result).error.code).to.equal('E_TARGET_NOT_FOUND');
    });

    it('404 NotFound when target is banned', async () => {
      const caller = adminCaller();
      sinon.stub(controller as any, 'loadTarget').resolves(makeUser({ Uuid: 'banned-uuid', Role: ['user'], IsBanned: true }));

      const dto = new ImpersonateDto({ TargetUuid: 'banned-uuid', Password: 'pwd' });
      const result = await controller.start(caller, session({ ActiveRole: 'admin' }), dto);

      expect(result).to.be.instanceOf(NotFound);
      expect(data(result).error.code).to.equal('E_TARGET_UNAVAILABLE');
    });

    it('403 E_TARGET_PROTECTED when target has a protected role', async () => {
      const caller = adminCaller();
      sinon.stub(controller as any, 'loadTarget').resolves(makeUser({ Uuid: 'system-uuid', Role: ['system'] }));
      setProtectedRoles(['system']);

      const dto = new ImpersonateDto({ TargetUuid: 'system-uuid', Password: 'pwd' });
      const result = await controller.start(caller, session({ ActiveRole: 'admin' }), dto);

      expect(result).to.be.instanceOf(ForbiddenResponse);
      expect(data(result).error.code).to.equal('E_TARGET_PROTECTED');
    });

    it('403 E_PRIVILEGE_ESCALATION when target has grants admin lacks', async () => {
      const caller = adminCaller();
      // Target with admin role — equal privileges → escalation per spec.
      sinon.stub(controller as any, 'loadTarget').resolves(makeUser({ Uuid: 'peer-admin-uuid', Role: ['admin'] }));

      const dto = new ImpersonateDto({ TargetUuid: 'peer-admin-uuid', Password: 'pwd' });
      const result = await controller.start(caller, session({ ActiveRole: 'admin' }), dto);

      expect(result).to.be.instanceOf(ForbiddenResponse);
      expect(data(result).error.code).to.equal('E_PRIVILEGE_ESCALATION');
    });

    it('401 E_PASSWORD_REQUIRED when requirePassword=true and no password supplied', async () => {
      const caller = adminCaller();
      sinon.stub(controller as any, 'loadTarget').resolves(userTarget());
      setRequirePassword(true);

      const dto = new ImpersonateDto({ TargetUuid: 'user-uuid' });
      const result = await controller.start(caller, session({ ActiveRole: 'admin' }), dto);

      expect(result).to.be.instanceOf(Unauthorized);
      expect(data(result).error.code).to.equal('E_PASSWORD_REQUIRED');
    });

    it('401 E_PASSWORD_INVALID when password is wrong', async () => {
      const caller = adminCaller();
      sinon.stub(controller as any, 'loadTarget').resolves(userTarget());
      setRequirePassword(true);
      sinon.stub(passwordProvider, 'verify').resolves(false);

      const dto = new ImpersonateDto({ TargetUuid: 'user-uuid', Password: 'wrong' });
      const result = await controller.start(caller, session({ ActiveRole: 'admin' }), dto);

      expect(result).to.be.instanceOf(Unauthorized);
      expect(data(result).error.code).to.equal('E_PASSWORD_INVALID');
    });

    it('skips password verification when requirePassword=false', async () => {
      const caller = adminCaller();
      sinon.stub(controller as any, 'loadTarget').resolves(userTarget());
      setRequirePassword(false);
      const verifySpy = sinon.spy(passwordProvider, 'verify');

      const dto = new ImpersonateDto({ TargetUuid: 'user-uuid' });
      const result = await controller.start(caller, session({ ActiveRole: 'admin' }), dto);

      expect(result).to.be.instanceOf(Ok);
      expect(verifySpy.called).to.be.false;
    });
  });

  describe('stop', () => {
    it('restores original session and emits UserImpersonationEnded', async () => {
      const target = userTarget(); // currently in storage.User
      const original = adminCaller();
      sinon.stub(controller as any, 'loadOriginal').resolves(original);

      const s = session({
        User: 'user-uuid',
        Impersonator: 'admin-uuid',
        ImpersonationStartedAt: '2026-06-01T00:00:00.000Z',
        OriginalActiveRole: 'admin',
        ActiveRole: 'user',
      });

      const result = await controller.stop(target, s);

      expect(result).to.be.instanceOf(Ok);
      const body = data(result);
      expect(body.Uuid).to.equal('admin-uuid');
      expect(body.ActiveRole).to.equal('admin');

      expect(s.Data.get('User')).to.equal('admin-uuid');
      expect(s.Data.has('Impersonator')).to.be.false;
      expect(s.Data.has('ImpersonationStartedAt')).to.be.false;
      expect(s.Data.has('OriginalActiveRole')).to.be.false;
      expect(s.Data.get('ActiveRole')).to.equal('admin');

      expect(sessionProvider.Saved).to.have.lengthOf(1);

      sinon.assert.calledOnce(evStub);
      const event = evStub.firstCall.args[0];
      expect(event).to.be.instanceOf(UserImpersonationEnded);
      expect((event as UserImpersonationEnded).UserUUID).to.equal('admin-uuid');
      expect((event as UserImpersonationEnded).TargetUUID).to.equal('user-uuid');
    });

    it('returns 400 when no impersonation is active', async () => {
      const result = await controller.stop(adminCaller(), session());
      expect(result).to.be.instanceOf(BadRequestResponse);
      expect(data(result).error.code).to.equal('E_NO_IMPERSONATION');
      sinon.assert.notCalled(evStub);
    });

    it('returns 400 E_IMPERSONATOR_GONE and cleans state when original cannot be loaded', async () => {
      sinon.stub(controller as any, 'loadOriginal').resolves(undefined);
      const target = userTarget();
      const s = session({
        User: 'user-uuid',
        Impersonator: 'admin-uuid',
        ImpersonationStartedAt: '2026-06-01T00:00:00.000Z',
      });

      const result = await controller.stop(target, s);

      expect(result).to.be.instanceOf(BadRequestResponse);
      expect(data(result).error.code).to.equal('E_IMPERSONATOR_GONE');
      // Stale impersonation block cleaned up
      expect(s.Data.has('Impersonator')).to.be.false;
      expect(s.Data.has('ImpersonationStartedAt')).to.be.false;
      expect(sessionProvider.Saved).to.have.lengthOf(1);
    });
  });

  describe('getState', () => {
    it('returns Active=false when no impersonation', async () => {
      const result = await controller.getState(undefined as any, undefined as any, undefined as any);
      expect(data(result)).to.deep.equal({ Active: false });
    });

    it('returns full impersonation state when active', async () => {
      const result = await controller.getState('admin-uuid', 'user-uuid', '2026-06-01T00:00:00.000Z');
      const body = data(result);
      expect(body.Active).to.be.true;
      expect(body.ImpersonatorUuid).to.equal('admin-uuid');
      expect(body.TargetUuid).to.equal('user-uuid');
      expect(body.StartedAt).to.equal('2026-06-01T00:00:00.000Z');
    });
  });
});
