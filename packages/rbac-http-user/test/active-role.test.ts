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
} from '@spinajs/rbac';

import { ActiveRoleController } from '../src/controllers/ActiveRoleController.js';
import { SwitchRoleDto } from '../src/dto/switchRole-dto.js';

import { Ok, BadRequestResponse, Unauthorized } from '@spinajs/http';

/**
 * Tests for the active-role switching controller. The controller is resolved
 * through the real DI container so @Autoinject / @AutoinjectService / @Config
 * decorators are exercised as they are in production. Provider implementations
 * are real classes registered under the abstract service bases; their methods
 * are sinon-stubbed per test to control behavior.
 */

class TestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      rbac: {
        // AutoinjectService('rbac.password') will resolve a service whose
        // constructor.name matches this string. Same for auth / session.
        password: { service: 'TestPasswordProvider' },
        auth: { service: 'TestAuthProvider' },
        session: { service: 'TestSessionProvider' },
        roleSwitch: { requirePassword: [] as string[] },
        grants: {
          admin: { Test: { 'read:any': ['*'] } },
          user: { Test: { 'read:own': ['*'] } },
        },
      },
    };
  }
}

class TestPasswordProvider extends PasswordProvider {
  public async verify(_hash: string, _password: string): Promise<boolean> {
    return true;
  }
  public async hash(input: string): Promise<string> {
    return `hashed:${input}`;
  }
  public generate(): string {
    return 'generated';
  }
}

class TestSessionProvider extends SessionProvider<ISession> {
  public Saved: ISession[] = [];
  public Deleted: string[] = [];
  public Store = new Map<string, ISession>();

  public async restore(id: string): Promise<ISession | null> {
    return this.Store.get(id) ?? null;
  }
  public async delete(id: string): Promise<void> {
    this.Deleted.push(id);
    this.Store.delete(id);
  }
  public async save(session: ISession): Promise<void> {
    this.Saved.push(session);
    this.Store.set(session.SessionId, session);
  }
  public async touch(_s: ISession): Promise<boolean> {
    return false;
  }
  public async deleteByUser(userId: number): Promise<void> {
    for (const [key, s] of this.Store.entries()) {
      if (s.UserId === userId) this.Store.delete(key);
    }
  }
  public async listByUser(userId: number): Promise<ISession[]> {
    return [...this.Store.values()].filter((s) => s.UserId === userId);
  }
  public async truncate(): Promise<void> {
    this.Store.clear();
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

describe('ActiveRoleController', function () {
  this.timeout(15000);

  let controller: ActiveRoleController;
  let passwordProvider: TestPasswordProvider;
  let sessionProvider: TestSessionProvider;

  before(() => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(TestPasswordProvider).as(PasswordProvider);
    DI.register(TestSessionProvider).as(SessionProvider);
    DI.register(TestAuthProvider).as(AuthProvider);
  });

  beforeEach(async () => {
    // Run all bootstrappers so AccessControl is registered and Configuration
    // listeners (which load grants into AccessControl) are wired.
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);

    controller = (await DI.resolve(ActiveRoleController)) as ActiveRoleController;
    passwordProvider = DI.get(PasswordProvider) as TestPasswordProvider;
    sessionProvider = DI.get(SessionProvider) as TestSessionProvider;
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  const data = (r: any) => (r as any).responseData;

  const buildUser = (roles: string[]) =>
    ({ Role: roles, Password: 'hashed-pass' } as any);

  const buildSession = (activeRole?: string): ISession => {
    const s = new UserSession();
    if (activeRole) s.Data.set('ActiveRole', activeRole);
    return s;
  };

  describe('AC is wired through DI', () => {
    it('controller AC contains grants from configuration', () => {
      const ac = (controller as any).AC as AccessControl;
      expect(ac).to.be.instanceOf(AccessControl);
      expect(ac.getRoles()).to.include.members(['admin', 'user']);
    });
  });

  describe('getActiveRole', () => {
    it('returns active role and grants resolved from DI-backed AccessControl', async () => {
      const user = buildUser(['admin', 'user']);

      const result = await controller.getActiveRole(user, 'admin');

      expect(result).to.be.instanceOf(Ok);
      const body = data(result);
      expect(body.ActiveRole).to.equal('admin');
      expect(body.Grants).to.have.property('Test');
    });

    it('falls back to first available role when session has no ActiveRole', async () => {
      const user = buildUser(['admin', 'user']);

      const result = await controller.getActiveRole(user, undefined as any);

      const body = data(result);
      expect(body.ActiveRole).to.equal('admin');
    });
  });

  describe('switchActiveRole', () => {
    it('switches successfully when role is in user.Role and persists via SessionProvider', async () => {
      const user = buildUser(['admin', 'user']);
      const session = buildSession('user');
      const dto = new SwitchRoleDto({ Role: 'admin' });

      const result = await controller.switchActiveRole(user, session, dto);

      expect(result).to.be.instanceOf(Ok);
      expect(session.Data.get('ActiveRole')).to.equal('admin');
      // Session is regenerated on role switch (session-fixation protection):
      // a new session is saved and it carries the switched ActiveRole.
      expect(sessionProvider.Saved).to.have.lengthOf(1);
      expect(sessionProvider.Saved[0].Data.get('ActiveRole')).to.equal('admin');

      const body = data(result);
      expect(body.ActiveRole).to.equal('admin');
    });

    it('regenerates the session on switch: new id issued, old id deleted, ssid cookie reset', async () => {
      const user = buildUser(['admin', 'user']);
      const session = buildSession('user');
      const oldId = session.SessionId;
      const dto = new SwitchRoleDto({ Role: 'admin' });

      const result = await controller.switchActiveRole(user, session, dto);

      expect(result).to.be.instanceOf(Ok);

      // old session invalidated, new one persisted with a different id
      expect(sessionProvider.Deleted).to.include(oldId);
      expect(sessionProvider.Saved).to.have.lengthOf(1);
      const regenerated = sessionProvider.Saved[0];
      expect(regenerated.SessionId).to.not.equal(oldId);

      // the response resets the ssid cookie to the regenerated id
      const cookies = (result as any).options?.Coockies ?? [];
      expect(cookies).to.have.lengthOf(1);
      expect(cookies[0].Name).to.equal('ssid');
      expect(cookies[0].Value).to.equal(regenerated.SessionId);
    });

    it('returns BadRequest when requested role is not assigned to the user', async () => {
      const user = buildUser(['user']);
      const session = buildSession('user');
      const dto = new SwitchRoleDto({ Role: 'super-admin' });

      const result = await controller.switchActiveRole(user, session, dto);

      expect(result).to.be.instanceOf(BadRequestResponse);
      expect(data(result).error.code).to.equal('E_ROLE_NOT_ASSIGNED');
      expect(session.Data.get('ActiveRole')).to.equal('user');
      expect(sessionProvider.Saved).to.be.empty;
    });

    it('returns Unauthorized when role requires password but none supplied', async () => {
      // Mutate the @Config-injected list at runtime; safe per test because of clearCache in afterEach
      Object.defineProperty(controller, 'RolesRequiringPassword', {
        value: ['admin'],
        configurable: true,
        writable: true,
      });

      const verifySpy = sinon.spy(passwordProvider, 'verify');

      const user = buildUser(['admin', 'user']);
      const session = buildSession('user');
      const dto = new SwitchRoleDto({ Role: 'admin' });

      const result = await controller.switchActiveRole(user, session, dto);

      expect(result).to.be.instanceOf(Unauthorized);
      expect(data(result).error.code).to.equal('E_PASSWORD_REQUIRED');
      expect(verifySpy.called).to.be.false;
      expect(sessionProvider.Saved).to.be.empty;
    });

    it('returns Unauthorized when supplied password is invalid', async () => {
      Object.defineProperty(controller, 'RolesRequiringPassword', {
        value: ['admin'],
        configurable: true,
        writable: true,
      });

      sinon.stub(passwordProvider, 'verify').resolves(false);

      const user = buildUser(['admin', 'user']);
      const session = buildSession('user');
      const dto = new SwitchRoleDto({ Role: 'admin', Password: 'wrong' });

      const result = await controller.switchActiveRole(user, session, dto);

      expect(result).to.be.instanceOf(Unauthorized);
      expect(data(result).error.code).to.equal('E_PASSWORD_INVALID');
      expect(sessionProvider.Saved).to.be.empty;
    });

    it('switches when password is required AND correctly verified by DI-resolved PasswordProvider', async () => {
      Object.defineProperty(controller, 'RolesRequiringPassword', {
        value: ['admin'],
        configurable: true,
        writable: true,
      });

      const verifyStub = sinon.stub(passwordProvider, 'verify').resolves(true);

      const user = buildUser(['admin', 'user']);
      const session = buildSession('user');
      const dto = new SwitchRoleDto({ Role: 'admin', Password: 'correct' });

      const result = await controller.switchActiveRole(user, session, dto);

      expect(result).to.be.instanceOf(Ok);
      expect(session.Data.get('ActiveRole')).to.equal('admin');
      sinon.assert.calledOnceWithExactly(verifyStub, 'hashed-pass', 'correct');
      expect(sessionProvider.Saved).to.have.lengthOf(1);
    });

    it('does not call PasswordProvider when switching to a role NOT listed in requirePassword', async () => {
      Object.defineProperty(controller, 'RolesRequiringPassword', {
        value: ['admin'],
        configurable: true,
        writable: true,
      });

      const verifySpy = sinon.spy(passwordProvider, 'verify');

      const user = buildUser(['admin', 'user']);
      const session = buildSession('admin');
      const dto = new SwitchRoleDto({ Role: 'user' });

      const result = await controller.switchActiveRole(user, session, dto);

      expect(result).to.be.instanceOf(Ok);
      expect(verifySpy.called).to.be.false;
      expect(sessionProvider.Saved).to.have.lengthOf(1);
    });
  });
});
