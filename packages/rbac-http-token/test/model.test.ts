import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, create } from '@spinajs/rbac';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';

describe('AccessToken model', function () {
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

    // `rbac_access_tokens.user_id` references `users`, and the Profile tests
    // below address their owner by a literal id rather than creating one, so
    // seed a user here - that keeps them passing when mocha is given a filter
    // that skips the tests which create their own owners.
    await create('model@spinajs.com', 'model', 'password123', ['user']);
  });

  after(async () => {
    DI.clearCache();
  });

  it('persists and loads a token with roles set and null expiry', async () => {
    const { User: owner } = await create('owner@spinajs.com', 'owner', 'password123', ['user']);

    const token = new AccessToken({
      Name: 'test token',
      Token: 'a'.repeat(64),
      Roles: ['user'],
      // omitted: the column is nullable and the property is optional, see AccessToken.ExpiresAt
      user_id: owner.Id,
    });
    await token.insert();

    const loaded = await AccessToken.where('Uuid', token.Uuid).firstOrFail();
    expect(loaded.Name).to.equal('test token');
    expect(loaded.Roles).to.deep.equal(['user']);
    expect(loaded.ExpiresAt).to.be.null;
    expect(loaded.IsExpired).to.be.false;
    expect(loaded.user_id).to.equal(owner.Id);
  });

  it('IsExpired is true for past ExpiresAt', async () => {
    const { User: owner } = await create('owner2@spinajs.com', 'owner2', 'password123', ['user']);
    const token = new AccessToken({
      Name: 'expired',
      Token: 'b'.repeat(64),
      Roles: ['user'],
      ExpiresAt: DateTime.now().minus({ hours: 1 }),
      user_id: owner.Id,
    });
    await token.insert();

    const loaded = await AccessToken.where('Uuid', token.Uuid).firstOrFail();
    expect(loaded.IsExpired).to.be.true;
  });

  it('hides hash, ids and owner when dehydrated', async () => {
    const { User: owner } = await create('owner3@spinajs.com', 'owner3', 'password123', ['user']);
    const token = new AccessToken({
      Name: 'hidden fields',
      Token: 'c'.repeat(64),
      Roles: ['user'],
      // omitted: the column is nullable and the property is optional, see AccessToken.ExpiresAt
      user_id: owner.Id,
    });
    await token.insert();

    const json = token.toJSON();
    expect(json).to.not.have.property('Token');
    expect(json).to.not.have.property('Id');
    expect(json).to.not.have.property('user_id');
    expect(json).to.have.property('Uuid');
    expect(json).to.have.property('Name');
  });

  it('persists and loads the Profile column', async () => {
    const token = new AccessToken({
      Name: 'profiled',
      Token: 'hash-profile-test',
      Roles: ['user'],
      Profile: 'admin.primespot',
      user_id: 1,
    });
    await token.insert();

    const loaded = await AccessToken.where('Uuid', token.Uuid).firstOrFail();
    expect(loaded.Profile).to.equal('admin.primespot');
  });

  it('leaves Profile undefined for legacy rows', async () => {
    const token = new AccessToken({ Name: 'legacy', Token: 'hash-legacy-test', Roles: ['user'], user_id: 1 });
    await token.insert();

    const loaded = await AccessToken.where('Uuid', token.Uuid).firstOrFail();
    expect(loaded.Profile ?? null).to.equal(null);
  });
});
