import 'mocha';
import { expect } from 'chai';
import { ConnectionState, OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';

import { AccessToken } from '../../src/models/AccessToken.js';
import { RbacHttpTokenInitial_2026_08_11_01_00_00 } from '../../src/migrations/RbacHttpTokenInitial_2026_08_11_01_00_00.js';
import { bootV3Db, insertUserRow, shutdownV3Db } from './db.js';

const COLUMNS = ['Id', 'Uuid', 'Name', 'Token', 'Roles', 'Profile', 'ExpiresAt', 'CreatedAt', 'LastUsedAt', 'user_id', 'Scope', 'Kind', 'RevokedAt', 'LastUsedIp'];

describe('RbacHttpTokenInitial migration', function () {
  this.timeout(15000);

  let connection: OrmDriver;
  let owner: number;
  const migration = new RbacHttpTokenInitial_2026_08_11_01_00_00();

  before(async () => {
    connection = await bootV3Db();
    owner = await insertUserRow(uuidv4());
  });

  after(async () => {
    await shutdownV3Db();
  });

  async function columns(): Promise<string[]> {
    return (await connection.tableInfo('rbac_access_tokens')).map((c) => c.Name);
  }

  it('creates rbac_access_tokens with the 3.0 columns', async () => {
    expect(await columns()).to.have.members(COLUMNS);
  });

  it('defaults Kind to pat for a row inserted without it', async () => {
    const uuid = uuidv4();
    await connection
      .insert()
      .into('rbac_access_tokens')
      .values({ Uuid: uuid, Name: 'no kind', Token: 'k'.repeat(64), Roles: 'user', ExpiresAt: DateTime.now().plus({ days: 1 }), user_id: owner });

    const rows = (await connection.select().from('rbac_access_tokens').where({ Uuid: uuid })) as Array<{ Kind: string }>;
    expect(rows[0].Kind).to.equal('pat');

    const loaded = await AccessToken.where('Uuid', uuid).firstOrFail();
    expect(loaded.Kind).to.equal('pat');
    expect(loaded.Scope).to.be.null;
    expect(loaded.RevokedAt).to.be.null;
  });

  it('stores Kind pat for a row built through the model without a valid kind', async () => {
    expect(new AccessToken().Kind).to.equal('pat');
    expect(new AccessToken({ Kind: 'bogus' as never }).Kind).to.equal('pat');
    expect(new AccessToken({ Kind: 'agent' }).Kind).to.equal('agent');
    expect(new AccessToken({ Kind: 'service' }).Kind).to.equal('service');

    const token = new AccessToken({ Name: 'model', Token: 'm'.repeat(64), Roles: ['user'], ExpiresAt: DateTime.now().plus({ days: 1 }), user_id: owner });
    await token.insert();

    const rows = (await connection.select().from('rbac_access_tokens').where({ Uuid: token.Uuid })) as Array<{ Kind: string }>;
    expect(rows[0].Kind).to.equal('pat');
  });

  it('the test users table refuses a duplicate Uuid or Login, as RBACInitial does', async () => {
    const uuid = uuidv4();
    await insertUserRow(uuid);
    const values = (over: Record<string, unknown>) => ({ Uuid: uuidv4(), Email: `${uuidv4()}@spinajs.test`, Password: 'x', Login: uuidv4(), IsActive: 1, ...over });

    const sameUuid = await connection
      .insert()
      .into('users')
      .values(values({ Uuid: uuid }))
      .catch((e: unknown) => e);
    expect(sameUuid, 'duplicate Uuid').to.be.instanceOf(Error);
    const sameLogin = await connection
      .insert()
      .into('users')
      .values(values({ Login: uuid }))
      .catch((e: unknown) => e);
    expect(sameLogin, 'duplicate Login').to.be.instanceOf(Error);
  });

  it('down drops the table', async () => {
    await migration.down(connection);
    try {
      expect(await connection.schema().tableExists('rbac_access_tokens')).to.equal(false);
    } finally {
      await migration.up(connection);
    }

    expect(await columns()).to.have.members(COLUMNS);
  });
});

describe('v3 test database', () => {
  it('shutdownV3Db closes the connection', async function () {
    this.timeout(15000);
    const connection = await bootV3Db();
    expect(connection.State).to.equal(ConnectionState.Connected);

    await shutdownV3Db();
    expect(connection.State).to.equal(ConnectionState.Disconnected);
  });
});
