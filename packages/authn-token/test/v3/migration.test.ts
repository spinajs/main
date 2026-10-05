import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ConnectionState, IdentifierQuoter, OrmDriver } from '@spinajs/orm';
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
  let configuredMaxTtlDays: unknown;

  before(async () => {
    connection = await bootV3Db();
    configuredMaxTtlDays = DI.get(Configuration)!.get(MAX_TTL_PATH);
    owner = await insertUserRow(uuidv4());
  });

  after(async () => {
    await shutdownV3Db();
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

  /** undefined puts the configured value back. */
  function setMaxTtlDays(value: number | undefined): void {
    DI.get(Configuration)!.set(MAX_TTL_PATH, value ?? configuredMaxTtlDays);
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

  it('down drops the columns through quoted identifiers', async () => {
    const quote = (n: string) => connection.Container.resolve<IdentifierQuoter>(IdentifierQuoter).quote(n);
    const driver = connection as unknown as { executeOnDb: (stmt: string, ...rest: unknown[]) => Promise<unknown> };
    const original = driver.executeOnDb;
    const statements: string[] = [];
    driver.executeOnDb = function (stmt: string, ...rest: unknown[]) {
      statements.push(String(stmt));
      return original.call(this, stmt, ...rest);
    };

    try {
      await migration.down(connection);
    } finally {
      driver.executeOnDb = original;
      await migration.up(connection);
    }

    const drops = statements.filter((s) => /DROP COLUMN/i.test(s));
    expect(drops).to.have.length(NEW_COLUMNS.length);
    for (const column of NEW_COLUMNS) {
      expect(
        drops.some((s) => s.includes(`DROP COLUMN ${quote(column)}`)),
        column,
      ).to.equal(true);
    }
  });

  it('back-fills a row whose CreatedAt is an ISO string written by the sqlite column default', async () => {
    setMaxTtlDays(undefined);
    await migration.down(connection);

    const uuid = uuidv4();
    const iso = '2026-01-15T10:20:30.000Z';
    await connection
      .insert()
      .into('rbac_access_tokens')
      .values({ Uuid: uuid, Name: 'iso', Token: uuid.replace(/-/g, '').padEnd(64, '1'), Roles: 'user', CreatedAt: iso, ExpiresAt: null, user_id: owner });

    await migration.up(connection);

    const row = await AccessToken.where('Uuid', uuid).firstOrFail();
    expect(row.ExpiresAt!.toMillis()).to.equal(DateTime.fromISO(iso).plus({ days: 90 }).toMillis());
  });

  it('the test users table refuses a duplicate Uuid or Login, as RBACInitial does', async () => {
    const uuid = uuidv4();
    await insertUserRow(uuid);
    const values = (over: Record<string, unknown>) => ({ Uuid: uuidv4(), Email: `${uuidv4()}@spinajs.test`, Password: 'x', Login: uuidv4(), Role: 'user', IsActive: 1, ...over });

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

describe('v3 test database', () => {
  it('shutdownV3Db closes the connection', async function () {
    this.timeout(15000);
    const connection = await bootV3Db();
    expect(connection.State).to.equal(ConnectionState.Connected);

    await shutdownV3Db();
    expect(connection.State).to.equal(ConnectionState.Disconnected);
  });
});
