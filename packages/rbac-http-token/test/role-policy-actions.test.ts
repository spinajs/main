import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, activate, create } from '@spinajs/rbac';
import { ErrorCode } from '@spinajs/exceptions';

import { DbTestConfiguration } from './db-common.js';
import { AccessTokenRolePolicy } from '../src/interfaces.js';
import { E_TOKEN_CODES, createToken, grantTokenRole, validateToken } from '../src/actions.js';
import '../src/generator.js';
import '../src/role-policy.js';

/**
 * A policy that answers with whatever the test told it to, so the suite can
 * prove the three call sites consult the policy rather than `owner.Role` -
 * which is the whole point of the seam.
 */
@Injectable(AccessTokenRolePolicy)
class StubTokenRolePolicy extends AccessTokenRolePolicy {
  public static Allowed: string[] = [];

  public async allowedRoles(_owner: User): Promise<string[]> {
    return [...StubTokenRolePolicy.Allowed];
  }
}

describe('access token actions - role policy', function () {
  this.timeout(15000);

  before(async () => {
    DI.setESMModuleSupport();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);

    // Point the configured policy at the stub for this suite.
    const cfg = await DI.resolve(Configuration);
    cfg.set('rbac.token.rolePolicy.service', 'StubTokenRolePolicy');
  });

  after(async () => {
    DI.clearCache();
  });

  beforeEach(() => {
    StubTokenRolePolicy.Allowed = [];
  });

  const owner = async (login: string) => {
    // `create` signature is `(email, login, password, roles, ...)` and returns
    // `{ User, Password }` - matches how the sibling suites (actions-crud,
    // actions-validate) call it. `create` also leaves the account inactive
    // ( see actions-validate.test.ts's `activeUser` ) - validateToken refuses
    // an inactive owner, so every fixture here has to be activated too, even
    // in tests that only exercise createToken / grantTokenRole.
    const { User: user } = await create(`${login}@spinajs.pl`, login, 'Bb1234567!', ['user']);
    await activate(user.Id);
    return user;
  };

  it('creates a token with a role the owner does not literally hold', async () => {
    const user = await owner('policy.create');
    StubTokenRolePolicy.Allowed = ['reports.read'];

    const { Token } = await createToken(user, 'scoped', ['reports.read'], null);

    expect(Token.Roles).to.deep.equal(['reports.read']);
  });

  it('refuses a role the policy does not allow', async () => {
    const user = await owner('policy.refuse');
    StubTokenRolePolicy.Allowed = ['reports.read'];

    await createToken(user, 'nope', ['billing.write'], null).then(
      () => expect.fail('createToken should have refused'),
      (err: unknown) => {
        expect(err).to.be.instanceOf(ErrorCode);
        expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);
      },
    );
  });

  it('grants a role the policy allows', async () => {
    const user = await owner('policy.grant');
    StubTokenRolePolicy.Allowed = ['reports.read', 'reports.write'];

    const { Token } = await createToken(user, 'grow', ['reports.read'], null);
    const updated = await grantTokenRole(Token, 'reports.write');

    expect(updated.Roles).to.have.members(['reports.read', 'reports.write']);
  });

  it('authenticates with the effective roles the policy still allows', async () => {
    const user = await owner('policy.validate');
    StubTokenRolePolicy.Allowed = ['reports.read', 'reports.write'];

    const { Plaintext } = await createToken(user, 'validate', ['reports.read', 'reports.write'], null);

    // The policy narrows AFTER the token was minted - the request-time answer
    // has to follow it, exactly as a revoked user role does.
    StubTokenRolePolicy.Allowed = ['reports.read'];

    const result = await validateToken(Plaintext);
    expect(result.EffectiveRoles).to.deep.equal(['reports.read']);
  });

  it('refuses a token whose roles the policy no longer allows at all', async () => {
    const user = await owner('policy.empty');
    StubTokenRolePolicy.Allowed = ['reports.read'];

    const { Plaintext } = await createToken(user, 'stale', ['reports.read'], null);

    StubTokenRolePolicy.Allowed = [];

    await validateToken(Plaintext).then(
      () => expect.fail('validateToken should have refused'),
      (err: unknown) => {
        expect((err as ErrorCode).code).to.equal(E_TOKEN_CODES.E_TOKEN_ROLE_NOT_ALLOWED);
      },
    );
  });
});
