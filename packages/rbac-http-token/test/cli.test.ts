import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, create, activate } from '@spinajs/rbac';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken } from '../src/actions.js';
import { CreateToken } from '../src/cli/CreateToken.js';
import { DeleteToken } from '../src/cli/DeleteToken.js';
import { GrantTokenRole } from '../src/cli/GrantTokenRole.js';
import { RevokeTokenRole } from '../src/cli/RevokeTokenRole.js';
import { DeleteExpiredTokens } from '../src/cli/DeleteExpiredTokens.js';
import '../src/generator.js';

describe('access token cli commands', function () {
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

  async function makeUser(mail: string, login: string, roles: string[] = ['user']) {
    const { User: u } = await create(mail, login, 'password123', roles);
    await activate(u.Id);
    return u;
  }

  it('rbac:token-create creates token for user', async () => {
    const user = await makeUser('cli1@spinajs.com', 'cli1');
    const cmd = await DI.resolve(CreateToken);

    await cmd.execute(user.Uuid, { name: 'cli token', roles: 'user', expires: undefined });

    const tokens = await AccessToken.where('user_id', user.Id);
    expect(tokens).to.have.length(1);
    expect(tokens[0].Name).to.equal('cli token');
    expect(tokens[0].ExpiresAt).to.be.null;
  });

  it('rbac:token-create honors --expires', async () => {
    const user = await makeUser('cli2@spinajs.com', 'cli2');
    const cmd = await DI.resolve(CreateToken);
    const iso = DateTime.now().plus({ days: 1 }).toISO()!;

    await cmd.execute(user.Uuid, { name: 'expiring', roles: 'user', expires: iso });

    const tokens = await AccessToken.where('user_id', user.Id);
    expect(tokens[0].ExpiresAt).to.not.be.null;
  });

  it('rbac:token-delete removes token', async () => {
    const user = await makeUser('cli3@spinajs.com', 'cli3');
    const { Token } = await createToken(user, 'doomed', ['user'], null);

    const cmd = await DI.resolve(DeleteToken);
    await cmd.execute(Token.Uuid);

    expect(await AccessToken.where('Uuid', Token.Uuid).first()).to.be.undefined;
  });

  it('rbac:token-grant / rbac:token-revoke mutate roles', async () => {
    const user = await makeUser('cli4@spinajs.com', 'cli4', ['user', 'admin']);
    const { Token } = await createToken(user, 'roles', ['user'], null);

    await (await DI.resolve(GrantTokenRole)).execute(Token.Uuid, 'admin');
    let row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.Roles).to.have.members(['user', 'admin']);

    await (await DI.resolve(RevokeTokenRole)).execute(Token.Uuid, 'admin');
    row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.Roles).to.deep.equal(['user']);
  });

  it('rbac:token-revoke refuses the last role, leaving the row untouched', async () => {
    const user = await makeUser('cli6@spinajs.com', 'cli6');
    const { Token } = await createToken(user, 'single role', ['user'], null);

    // the action throws on a last-role revoke; the command swallows it into a
    // log line, so the row is the only observable proof the revoke was refused
    await (await DI.resolve(RevokeTokenRole)).execute(Token.Uuid, 'user');

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.Roles).to.deep.equal(['user']);
  });

  it('rbac:token-delete-expired removes only expired tokens', async () => {
    const user = await makeUser('cli5@spinajs.com', 'cli5');
    const { Token: live } = await createToken(user, 'live', ['user'], null);
    const { Token: dead } = await createToken(user, 'dead', ['user'], DateTime.now().plus({ minutes: 1 }));

    const row = await AccessToken.where('Uuid', dead.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 1 });
    await row.update();

    await (await DI.resolve(DeleteExpiredTokens)).execute();

    expect(await AccessToken.where('Uuid', live.Uuid).first()).to.not.be.undefined;
    expect(await AccessToken.where('Uuid', dead.Uuid).first()).to.be.undefined;
  });
});
