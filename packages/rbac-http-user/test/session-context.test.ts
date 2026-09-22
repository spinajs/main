import 'mocha';
import { expect } from 'chai';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import {
  PasswordProvider,
  SessionProvider,
  AuthProvider,
  ISession,
  UserSession,
  AccessControl,
} from '@spinajs/rbac';
import type { User } from '@spinajs/rbac';
import { SessionContextProvider } from '@spinajs/rbac-http';

import { LoginController } from '../src/controllers/LoginController.js';
import { ActiveRoleController } from '../src/controllers/ActiveRoleController.js';
import { SwitchRoleDto } from '../src/dto/switchRole-dto.js';
import { buildUserWithGrants } from '../src/services/grants.js';

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
        twoFactorAuth: { enabled: true, forceUser: false },
        grants: { admin: { Test: { 'read:any': ['*'] } }, salesman: { Test: { 'read:own': ['*'] } } },
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
    return 'generated';
  }
}

class TestSessionProvider extends SessionProvider<ISession> {
  public Store = new Map<string, ISession>();
  public async restore(id: string): Promise<ISession | null> {
    return this.Store.get(id) ?? null;
  }
  public async delete(id: string): Promise<void> {
    this.Store.delete(id);
  }
  public async save(session: ISession): Promise<void> {
    this.Store.set(session.SessionId, session);
  }
  public async touch(): Promise<boolean> {
    return false;
  }
  public async deleteByUser(): Promise<void> {}
  public async listByUser(): Promise<ISession[]> {
    return [];
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

/** Echoes the role the response reports, so a test can tell which role it was resolved for. */
class RoleEchoContext extends SessionContextProvider {
  public static Properties = { EchoedRole: { type: 'string' } };

  public resolve(_user: User, activeRole: string | undefined) {
    return { EchoedRole: activeRole };
  }
}

describe('SessionContextProvider', function () {
  this.timeout(15000);

  let login: LoginController;
  let activeRole: ActiveRoleController;

  before(() => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(TestPasswordProvider).as(PasswordProvider);
    DI.register(TestSessionProvider).as(SessionProvider);
    DI.register(TestAuthProvider).as(AuthProvider);
    DI.register(RoleEchoContext).as(SessionContextProvider);
  });

  after(() => {
    // other suites share the root container and compare whole response bodies
    DI.unregister(RoleEchoContext);
    DI.clearCache();
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
    await DI.resolve(Configuration);
    login = (await DI.resolve(LoginController)) as LoginController;
    activeRole = (await DI.resolve(ActiveRoleController)) as ActiveRoleController;
  });

  afterEach(() => {
    DI.clearCache();
  });

  const data = (r: any) => (r as any).responseData;

  const buildUser = () =>
    ({
      Role: ['admin', 'salesman'],
      Password: 'hashed-pass',
      dehydrateWithRelations: () => ({ Uuid: 'u-1', Role: 'admin' }),
    }) as any;

  const buildSession = (role?: string): ISession => {
    const session = new UserSession();
    session.Data.set('Authorized', true);
    if (role) session.Data.set('ActiveRole', role);
    return session;
  };

  it('adds provider fields to whoami, resolved for the session active role', async () => {
    const result = await login.whoami(buildUser(), 'salesman', buildSession('salesman') as any);

    expect(data(result).EchoedRole).to.equal('salesman');
  });

  it('adds provider fields to the login-style payload', async () => {
    const payload = await buildUserWithGrants(buildUser(), 'admin', DI.get(AccessControl) as AccessControl);

    expect(payload).to.include({ EchoedRole: 'admin', ActiveRole: 'admin', Uuid: 'u-1' });
  });

  it('adds provider fields to GET /auth/active-role', async () => {
    const result = await activeRole.getActiveRole(buildUser(), 'admin');

    expect(data(result).EchoedRole).to.equal('admin');
  });

  it('resolves provider fields for the role switched to, not the one switched from', async () => {
    const result = await activeRole.switchActiveRole(buildUser(), buildSession('admin'), new SwitchRoleDto({ Role: 'salesman' }));

    expect(data(result)).to.include({ ActiveRole: 'salesman', EchoedRole: 'salesman' });
  });
});
