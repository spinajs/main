import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';

import { AccessToken } from '../../src/models/AccessToken.js';
import { AuthnTokenScope_2026_10_02_00_00_00 } from '../../src/migrations/AuthnTokenScope_2026_10_02_00_00_00.js';
import { bootV3Db, insertUserRow, shutdownV3Db } from './db.js';

const NEW_COLUMNS = ['Scope', 'Kind', 'RevokedAt', 'LastUsedIp'];
const MAX_TTL_PATH = ['authn', 'token', 'maxTtlDays'];

describe('AuthnTokenScope migration', function () {
  this.timeout(15000);

  let connection: OrmDriver;
  let owner: number;
  const migration = new AuthnTokenScope_2026_10_02_00_00_00();

  before(async () => {
    connection = await bootV3Db();
    owner = await insertUserRow(uuidv4());
  });

  after(() => {
    shutdownV3Db();
  });

  async function columns(): Promise<string[]> {
    return (await connection.tableInfo('rbac_access_tokens')).map((c) => c.Name);
  }

  /**
   * A row as 2.x wrote it, inserted while the new columns are dropped.
   */
  async function insert2xRow(createdAt: DateTime, expiresAt?: DateTime): Promise<string> {
    const uuid = uuidv4();
    await connection
      .insert()
      .into('rbac_access_tokens')
      .values({ Uuid: uuid, Name: 'legacy', Token: uuid.replace(/-/g, '').padEnd(64, '0'), Roles: 'user', CreatedAt: createdAt, ExpiresAt: expiresAt ?? null, user_id: owner });
    return uuid;
  }

  function setMaxTtlDays(value: number | undefined): void {
    DI.get(Configuration)!.set(MAX_TTL_PATH, value);
  }

  it('adds Scope, Kind, RevokedAt and LastUsedIp', async () => {
    expect(await columns()).to.include.members(NEW_COLUMNS);
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

  it('down removes the four columns', async () => {
    await migration.down(connection);
    try {
      expect(await columns()).to.not.include.any.members(NEW_COLUMNS);
    } finally {
      await migration.up(connection);
    }

    expect(await columns()).to.include.members(NEW_COLUMNS);
  });

  it('back-fills a null ExpiresAt with CreatedAt + 90 days by default and keeps a set one', async () => {
    setMaxTtlDays(undefined);
    await migration.down(connection);

    const createdAt = DateTime.fromISO('2026-01-15T10:20:30.000');
    const kept = DateTime.fromISO('2027-03-01T08:00:00.000');
    const old = DateTime.now().minus({ days: 200 }).startOf('second');

    const open = await insert2xRow(createdAt);
    const set = await insert2xRow(createdAt, kept);
    const stale = await insert2xRow(old);

    await migration.up(connection);

    const openRow = await AccessToken.where('Uuid', open).firstOrFail();
    expect(openRow.CreatedAt.toMillis()).to.equal(createdAt.toMillis());
    expect(openRow.ExpiresAt!.toMillis()).to.equal(createdAt.plus({ days: 90 }).toMillis());

    const setRow = await AccessToken.where('Uuid', set).firstOrFail();
    expect(setRow.ExpiresAt!.toMillis()).to.equal(kept.toMillis());

    // CreatedAt + 90 days lies in the past, so the token is simply expired
    const staleRow = await AccessToken.where('Uuid', stale).firstOrFail();
    expect(staleRow.ExpiresAt!.toMillis()).to.equal(old.plus({ days: 90 }).toMillis());
    expect(staleRow.IsExpired).to.be.true;
  });

  it('honours a configured authn.token.maxTtlDays', async () => {
    await migration.down(connection);
    const createdAt = DateTime.fromISO('2026-05-10T12:00:00.000');
    const uuid = await insert2xRow(createdAt);

    setMaxTtlDays(7);
    try {
      await migration.up(connection);
    } finally {
      setMaxTtlDays(undefined);
    }

    const row = await AccessToken.where('Uuid', uuid).firstOrFail();
    expect(row.ExpiresAt!.toMillis()).to.equal(createdAt.plus({ days: 7 }).toMillis());
  });
});
