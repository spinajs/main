import 'mocha';
import { expect } from 'chai';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';

import { bootV3Db, insertUserRow, shutdownV3Db } from './v3/db.js';
import { AccessToken } from '../src/models/AccessToken.js';

// A bare `users` row: the suite boots only this package's migrations.
const insertOwner = async (): Promise<{ Id: number }> => ({ Id: await insertUserRow(uuidv4()) });

describe('AccessToken model', function () {
  this.timeout(15000);

  before(async () => {
    await bootV3Db();

    // The Profile tests below address their owner by a literal id rather than creating one, so seed a user here -
    // that keeps them passing when mocha is given a filter that skips the tests which create their own owners.
    await insertOwner();
  });

  after(async () => {
    await shutdownV3Db();
  });

  it('persists and loads a token with roles set and null expiry', async () => {
    const owner = await insertOwner();

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
    const owner = await insertOwner();
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
    const owner = await insertOwner();
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
