import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, activate, create } from '@spinajs/users';
import { AccessTokenNotFound } from '../src/legacy/exceptions.js';
import { FakeIdentityStore } from '@spinajs/authn-testing';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken, validateToken } from '../src/legacy/actions.js';
import { DbTokenService, NoTokenProfilesPolicy, UsersTableTokenOwnerResolver } from '../src/service/index.js';
import '../src/generator.js';
import '../src/legacy/role-policy.js';

describe('access token actions - validate & cleanup', function () {
  this.timeout(15000);

  before(async () => {
    DI.setESMModuleSupport();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    // rbac wires its AccessControl instance and user factories from a
    // bootstrapper; nothing runs bootstrappers for us outside a real app.
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  after(async () => {
    DI.clearCache();
  });

  /**
   * `create` leaves the account inactive - validation refuses inactive owners,
   * so every fixture user here has to be activated first.
   */
  async function activeUser(mail: string, login: string, roles: string[]) {
    const { User: u } = await create(mail, login, roles, { password: 'password123' });
    await activate(u.Id);
    return u;
  }

  // Both look like an unknown token, so a caller cannot probe which rows exist.
  it('rejects a revoked token as an unknown token', async () => {
    const owner = await activeUser('v11@spinajs.com', 'v11', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'revoked', ['user'], null);

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.RevokedAt = DateTime.now();
    await row.update();

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AccessTokenNotFound);
    expect((err as Error).message).to.equal('Access token not found');
  });

  it('rejects a 3.0 agent token as an unknown token', async () => {
    const owner = await activeUser('v12@spinajs.com', 'v12', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'agent', ['user'], null);

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.Kind = 'agent';
    await row.update();

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AccessTokenNotFound);
    expect((err as Error).message).to.equal('Access token not found');
  });

  it('rejects a 3.0 service token as an unknown token', async () => {
    const owner = await activeUser('v13@spinajs.com', 'v13', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'service', ['user'], null);

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.Kind = 'service';
    await row.update();

    const err = await validateToken(Plaintext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AccessTokenNotFound);
    expect((err as Error).message).to.equal('Access token not found');
  });

  // The 2.x path cannot honour scope limits, so it would widen the token to its full roles.
  for (const [n, label, scope] of [
    [1, 'permissions', { permissions: ['file:read'] }],
    [2, 'resources', { resources: [{ type: 'file', id: '7' }] }],
    [3, 'permissions to none', { permissions: [] }],
  ] as const) {
    it(`rejects a token with a scope limiting ${label} as an unknown token`, async () => {
      const owner = await activeUser(`v14-${n}@spinajs.com`, `v14-${n}`, ['user']);
      const { Token, Plaintext } = await createToken(owner, 'scoped', ['user'], null);

      const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
      row.Scope = scope;
      await row.update();

      const err = await validateToken(Plaintext).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(AccessTokenNotFound);
      expect((err as Error).message).to.equal('Access token not found');
    });
  }

  it('createToken stores Kind pat in the column', async () => {
    const owner = await activeUser('v15@spinajs.com', 'v15', ['user']);
    const { Token } = await createToken(owner, 'kind', ['user'], null);

    const rows = (await DI.get(Orm)!.Connections.get('sqlite')!.select().from('rbac_access_tokens').where({ Uuid: Token.Uuid })) as Array<{ Kind: string }>;
    expect(rows[0].Kind).to.equal('pat');
  });

  it('a token minted through createToken validates through DbTokenService and lists as a pat', async () => {
    const owner = await activeUser('v16@spinajs.com', 'v16', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'cross', ['user'], DateTime.now().plus({ days: 1 }));

    const identities = new FakeIdentityStore();
    const ref = identities.add({ login: 'v16', id: owner.Uuid });
    const tokens = new DbTokenService(new UsersTableTokenOwnerResolver(), new NoTokenProfilesPolicy(), identities);
    const now = new Date();

    const result = await tokens.validate(Plaintext, { now, purpose: 'request' });
    expect(result.ok).to.equal(true);
    expect(result.ok && result.identity).to.deep.equal(ref);
    expect(result.ok && result.ceiling).to.deep.equal({ roles: ['user'] });

    const listed = await tokens.list(ref);
    expect(listed.map((r) => [r.id, r.kind])).to.deep.equal([[Token.Uuid, 'pat']]);
  });
});
