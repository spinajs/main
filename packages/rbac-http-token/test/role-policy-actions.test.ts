import 'mocha';
import { expect } from 'chai';
import { AccessControl } from 'accesscontrol';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, activate, create } from '@spinajs/rbac';
import { AccessTokenRoleNotAllowed } from '../src/exceptions.js';

import { DbTestConfiguration } from './db-common.js';
import { AccessTokenRolePolicy } from '../src/interfaces.js';
import { _allowed_roles, createToken, grantTokenRole, validateToken } from '../src/actions.js';
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

    // `reports.read` / `reports.write` below stand in for roles a policy may
    // grant beyond what the owner literally holds - they must still be roles
    // AccessControl actually knows about ( `_allowed_roles` filters out
    // anything absent from `ac.getGrants()`, see actions.ts ), otherwise every
    // request a token carrying them later authenticates would 500. What they
    // grant is irrelevant to this suite; only their presence in the map is.
    const ac = DI.get<AccessControl>('AccessControl')!;
    ac.grant('reports.read').readOwn('reports');
    ac.grant('reports.write').updateOwn('reports');
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
    const { User: user } = await create(`${login}@spinajs.pl`, login, ['user'], { password: 'Bb1234567!' });
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
        expect(err).to.be.instanceOf(AccessTokenRoleNotAllowed);
        
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
        expect(err).to.be.instanceOf(AccessTokenRoleNotAllowed);
      },
    );
  });

  /**
   * `_allowed_roles` (actions.ts) filters a policy's answer down to roles
   * `accesscontrol` actually knows about. A policy is arbitrary application
   * code and a typo'd or stale role name must not reach `createToken` /
   * `validateToken` unfiltered - `checkRoutePermission` (rbac-http) calls
   * `ac.can(roles)[permission](resource)`, and `accesscontrol` throws for any
   * role absent from its grants map, which would 500 every request the token
   * later authenticates.
   */
  it('never puts a role the policy returns but AccessControl does not know onto a token', async () => {
    const user = await owner('policy.unknown-create');
    StubTokenRolePolicy.Allowed = ['reports.read', 'ghost-role'];

    await createToken(user, 'partially unknown', ['reports.read', 'ghost-role'], null).then(
      () => expect.fail('createToken should have refused the unknown role'),
      (err: unknown) => {
        expect(err).to.be.instanceOf(AccessTokenRoleNotAllowed);
        
        expect((err as AccessTokenRoleNotAllowed).data).to.deep.equal({ roles: ['ghost-role'] });
      },
    );
  });

  /**
   * `_allowed_roles` used to filter with `Boolean(grants[r])`. `getGrants()` returns a
   * plain object, so `grants['constructor']` (and `toString`/`valueOf`/`hasOwnProperty`/
   * `__proto__`) resolves truthy through the prototype chain even though no such role was
   * ever registered with `AccessControl` - a policy returning `'constructor'` would survive
   * the old filter, be offered by `GET user/tokens/roles`, and be mintable onto a token.
   * The filter now uses `Object.hasOwn`, which only recognises the grants map's own keys.
   */
  it('never lets a prototype-chain property name through as an allowed role', async () => {
    const user = await owner('policy.prototype-property');
    StubTokenRolePolicy.Allowed = ['reports.read', 'constructor'];

    const allowed = await _allowed_roles(user);

    expect(allowed).to.deep.equal(['reports.read']);
    expect(allowed).to.not.include('constructor');
  });

  it('never puts a policy-returned unknown role into EffectiveRoles', async () => {
    const user = await owner('policy.unknown-validate');
    StubTokenRolePolicy.Allowed = ['reports.read'];

    const { Plaintext } = await createToken(user, 'later unknown', ['reports.read'], null);

    // The policy now offers a role AccessControl has never heard of, alongside
    // one it still legitimately allows.
    StubTokenRolePolicy.Allowed = ['reports.read', 'ghost-role'];

    const result = await validateToken(Plaintext);
    expect(result.EffectiveRoles).to.deep.equal(['reports.read']);
    expect(result.EffectiveRoles).to.not.include('ghost-role');
  });
});
