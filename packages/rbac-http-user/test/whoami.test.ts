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
} from '@spinajs/rbac';

import { LoginController } from '../src/controllers/LoginController.js';
import { Ok } from '@spinajs/http';

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
        grants: { admin: { Test: { 'read:any': ['*'] } } },
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

describe('LoginController.whoami', function () {
  this.timeout(15000);

  let controller: LoginController;

  before(() => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(TestPasswordProvider).as(PasswordProvider);
    DI.register(TestSessionProvider).as(SessionProvider);
    DI.register(TestAuthProvider).as(AuthProvider);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
    await DI.resolve(Configuration);
    controller = (await DI.resolve(LoginController)) as LoginController;
  });

  afterEach(() => {
    DI.clearCache();
  });

  const data = (r: any) => (r as any).responseData;

  // `dehydrateWithRelations` flattens the Role relation to a single string —
  // that is what the real model does, and it is what whoami has to undo.
  const buildUser = () =>
    ({
      Role: ['admin', 'salesman'],
      dehydrateWithRelations: () => ({ Email: 'a@b.c', Role: 'admin' }),
    }) as any;

  it('reports Authorized: true for a fully authorized session', async () => {
    const session = new UserSession();
    session.Data.set('Authorized', true);

    const result = await controller.whoami(
      buildUser(),
      'admin',
      session as any,
    );

    expect(result).to.be.instanceOf(Ok);
    expect(data(result).Authorized).to.equal(true);
  });

  /**
   * The endpoint a client restores a session from, so the role list it sends is
   * the one the role picker renders. Left flattened, a multi-role user who
   * refreshes the page keeps only the role they were acting as and cannot
   * switch back until they log in again.
   */
  it('sends every assigned role, not the flattened relation', async () => {
    const session = new UserSession();
    session.Data.set('Authorized', true);

    const result = await controller.whoami(buildUser(), 'admin', session as any);

    expect(data(result).Role).to.deep.equal(['admin', 'salesman']);
  });

  it('reports Authorized: false for a session mid-2FA', async () => {
    const session = new UserSession();
    session.Data.set('Authorized', false);
    session.Data.set('TwoFactorAuth', true);

    const result = await controller.whoami(
      buildUser(),
      'admin',
      session as any,
    );

    expect(data(result).Authorized).to.equal(false);
  });

  // Sessions minted before this field existed carry no `Authorized` key at all.
  // They predate 2FA gating and were, by definition, fully authorized — so the
  // absent key must read as true, not as a falsy "not authorized". This is the
  // branch that keeps the endpoint backwards-compatible across a deploy, and it
  // mirrors the frontend's own `data.Authorized ?? true` fallback.
  it('reports Authorized: true when the session carries no Authorized key', async () => {
    const session = new UserSession();

    expect(session.Data.has('Authorized')).to.be.false;

    const result = await controller.whoami(
      buildUser(),
      'admin',
      session as any,
    );

    expect(result).to.be.instanceOf(Ok);
    expect(data(result).Authorized).to.equal(true);
  });
});
