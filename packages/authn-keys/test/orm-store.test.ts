import 'mocha';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import type { KeyRecord } from '@spinajs/authn/contracts';
import { generateKeyPair } from '@spinajs/authn-testing';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { Orm } from '@spinajs/orm';
import { keyLine } from '../src/cli/ListKeys.js';
import { thumbprint } from '../src/jwk/index.js';
import { AuthnKey } from '../src/models/AuthnKey.js';
import { OrmKeyStore } from '../src/registry/index.js';
import { isUsableKey } from '../src/registry/registry.js';
import { bootSqlite, clearKeys } from './db.js';

function withZone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.TZ;
  process.env.TZ = zone;
  return fn().finally(() => {
    if (before === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = before;
    }
  });
}

describe('OrmKeyStore', () => {
  beforeEach(async () => {
    await bootSqlite();
    await clearKeys();
  });

  it('round-trips a key and keeps its instants whatever the process time zone', async () => {
    const store = new OrmKeyStore();
    const kp = generateKeyPair('ES256');
    const at = new Date(Date.UTC(2026, 9, 25, 0, 30, 0));
    const key = { alg: 'ES256', jwk: kp.publicJwk, kid: 'k-1', owner: { type: 'service', id: 's' }, thumbprint: thumbprint(kp.publicJwk), name: 'n', scope: { roles: ['r'] }, createdAt: at, createdBy: { type: 'user', id: 'admin' }, expiresAt: new Date(at.getTime() + 3_600_000) } as KeyRecord;
    await withZone('America/New_York', () => store.insert(key));
    const read = await withZone('Asia/Tokyo', () => store.get('k-1'));
    assert.deepStrictEqual(read, key);
    assert.strictEqual(await withZone('Europe/Warsaw', () => store.revoke({ type: 'service', id: 's' }, 'k-1', at)), 'revoked');
    assert.strictEqual((await withZone('Asia/Tokyo', () => store.get('k-1')))?.revokedAt?.getTime(), at.getTime());
    assert.strictEqual(await store.revoke({ type: 'service', id: 's' }, 'k-1', new Date()), 'already');
    assert.strictEqual(await store.revoke({ type: 'agent', id: 's' }, 'k-1', new Date()), 'none');
  });

  it('does not read an update without a row count as a revoke, so a racing revoke cannot publish twice', async () => {
    const store = new OrmKeyStore();
    const kp = generateKeyPair('ES256');
    const owner = { type: 'service', id: 's' } as const;
    await store.insert({ alg: 'ES256', jwk: kp.publicJwk, kid: 'k-4', owner, thumbprint: thumbprint(kp.publicJwk), createdAt: new Date() } as KeyRecord);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- detached only to be restored; the patch calls it with its receiver
    const update = AuthnKey.update;
    const original = update as unknown as (this: unknown, ...args: unknown[]) => { execute(): Promise<unknown> };
    // A driver that reports no RowsAffected.
    AuthnKey.update = function (this: unknown, ...args: unknown[]) {
      const q = original.apply(this, args);
      const execute = q.execute.bind(q);
      q.execute = () => execute().then(() => ({}));
      return q;
    } as unknown as typeof update;
    try {
      assert.strictEqual(await store.revoke(owner, 'k-4', new Date()), 'already');
    } finally {
      AuthnKey.update = update;
    }
  });

  it('reports a duplicate kid or thumbprint', async () => {
    const store = new OrmKeyStore();
    const kp = generateKeyPair('EdDSA');
    const key = { alg: 'EdDSA', jwk: kp.publicJwk, kid: 'k-2', owner: { type: 'service', id: 's' }, thumbprint: thumbprint(kp.publicJwk), createdAt: new Date() } as KeyRecord;
    assert.strictEqual(await store.insert(key), 'inserted');
    assert.strictEqual(await store.insert({ ...key, kid: 'k-3' }), 'duplicate');
    const other = generateKeyPair('EdDSA');
    assert.strictEqual(await store.insert({ ...key, jwk: other.publicJwk, thumbprint: thumbprint(other.publicJwk) } as KeyRecord), 'duplicate');
  });

  describe('an expires_at or revoked_at no datetime converter reads', () => {
    const OWNER = { type: 'service', id: 's' } as const;
    // The SQLite column keeps any text; the converter reads each of these as null, as it reads NULL.
    const UNREADABLE = ['not a date', '', 'now', '0000-00-00 00:00:00', '1e300'];

    afterEach(() => sinon.restore());

    /** Writes past the model's converter, as an operator's SQL would, and checks the value the table now holds. */
    const write = async (kid: string, column: 'expires_at' | 'revoked_at', value: string): Promise<void> => {
      const connection = DI.get(Orm)!.Connections.get('sqlite')!;
      await connection.update().in('authn_key').update({ [column]: value }).where('kid', kid);
      const [stored] = await connection.select<Record<string, unknown>[]>().from('authn_key').columns([column]).where('kid', kid);
      assert.deepStrictEqual(Object.values(stored), [value], 'the value the test meant to store');
    };

    const seed = async (store: OrmKeyStore, kid: string): Promise<KeyRecord> => {
      const kp = generateKeyPair('ES256');
      if (kp.publicJwk.kty !== 'EC') throw new Error('ES256 gives a P-256 key');
      const key: KeyRecord = { alg: 'ES256', jwk: kp.publicJwk, kid, owner: OWNER, thumbprint: thumbprint(kp.publicJwk), createdAt: new Date() };
      await store.insert(key);
      return key;
    };

    const warnings = (): sinon.SinonSpy => sinon.spy(DI.resolve(Log, ['authn-keys']), 'warn');

    it('treats a key whose revoked_at no converter reads as revoked, through get and listByOwner', async () => {
      const store = new OrmKeyStore();
      for (const value of UNREADABLE) {
        await clearKeys();
        const key = await seed(store, 'k-6');
        await write('k-6', 'revoked_at', value);
        const warn = warnings();

        const read = await store.get('k-6');
        assert.ok(read?.revokedAt instanceof Date && Number.isNaN(read.revokedAt.getTime()), value);
        assert.strictEqual(read.expiresAt, undefined, value);
        assert.strictEqual(isUsableKey(read, new Date()), false, value);
        assert.strictEqual(isUsableKey((await store.listByOwner(OWNER))[0], new Date()), false, value);
        assert.match(keyLine(read), /revoked unreadable/, value);
        assert.strictEqual(await store.revoke(OWNER, 'k-6', new Date()), 'already', value);
        assert.strictEqual(await store.revoke(OWNER, 'k-6', new Date()), 'already', `${value}: the stored value was not overwritten`);

        // get, listByOwner and the two reads of revoke: one warning each, naming the kid and no key material
        const messages = warn.getCalls().map((c) => String(c.lastArg));
        assert.strictEqual(messages.length, 4, value);
        assert.ok(
          messages.every((m) => m.includes('k-6') && m.includes('revoked_at') && !m.includes(key.thumbprint) && !m.includes(key.jwk.x)),
          value,
        );
        sinon.restore();
      }
    });

    it('treats a key whose expires_at no converter reads as expired, and a NULL as no expiry', async () => {
      const store = new OrmKeyStore();
      for (const value of UNREADABLE) {
        await clearKeys();
        await seed(store, 'k-7');
        await seed(store, 'k-8');
        await write('k-7', 'expires_at', value);
        const warn = warnings();

        const bad = await store.get('k-7');
        assert.ok(bad?.expiresAt instanceof Date && Number.isNaN(bad.expiresAt.getTime()), value);
        assert.strictEqual(bad.revokedAt, undefined, value);
        assert.strictEqual(isUsableKey(bad, new Date()), false, value);
        assert.match(keyLine(bad), /expires unreadable/, value);
        const listed = await store.listByOwner(OWNER);
        assert.strictEqual(isUsableKey(listed.find((k) => k.kid === 'k-7')!, new Date()), false, value);
        const plain = listed.find((k) => k.kid === 'k-8');
        assert.strictEqual(plain?.expiresAt, undefined, value);
        assert.strictEqual(isUsableKey(plain!, new Date()), true, value);
        assert.strictEqual(warn.callCount, 2, `${value}: one warning per read of the row, none for the NULL one`);
        sinon.restore();
      }
    });

    it('still reads a past, a future and a zone-less instant as datetimes, without a warning', async () => {
      const store = new OrmKeyStore();
      await seed(store, 'past');
      await seed(store, 'future');
      await seed(store, 'zoneless');
      await write('past', 'expires_at', '2020-01-01T00:00:00.000Z');
      await write('future', 'expires_at', '2099-01-01T00:00:00.000Z');
      await write('zoneless', 'revoked_at', '2026-06-01 12:00:00');
      const warn = warnings();

      const now = new Date('2026-11-27T00:00:00.000Z');
      assert.strictEqual(isUsableKey((await store.get('past'))!, now), false);
      assert.strictEqual((await store.get('future'))?.expiresAt?.toISOString(), '2099-01-01T00:00:00.000Z');
      assert.strictEqual(isUsableKey((await store.get('future'))!, now), true);
      assert.strictEqual((await store.get('zoneless'))?.revokedAt?.toISOString(), '2026-06-01T12:00:00.000Z');
      assert.strictEqual(warn.callCount, 0);
    });
  });
});
