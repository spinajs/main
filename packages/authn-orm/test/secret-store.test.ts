import { FakeClock, FakeIdentityStore, MemoryPasswordCredentialStore, fakeSeedPort, runSecretStoreConformance } from '@spinajs/authn-testing';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { createHash } from 'node:crypto';

import { DbSecretStore, fromUtcColumn, parseIdentityKey } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const T0 = new Date('2026-06-01T10:00:00.000Z');
const ALICE: IdentityRef = { type: 'user', id: '0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10' };
const BOB: IdentityRef = { type: 'user', id: '5e0d7f3a-2b44-4d8e-a1c9-6f2e8b3d0c21' };
const KID = createHash('sha256').update('n4-kid').digest('hex');
const KEY: IdentityRef = { type: 'key', id: KID };
const CHALLENGE = 'key-challenge:' + 'r1d2e3f4g5h6i7j8';

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

async function expectInvalid(p: Promise<unknown>): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).to.be.instanceOf(InvalidArgument);
}

interface SecretRowText {
  id: string;
  identity: string;
  purpose: string;
  secret_hash: string;
  expires_text: string;
  used_text: string | null;
  created_text: string;
}

async function secretRows(db: TestDb): Promise<SecretRowText[]> {
  return (await rawQuery(db.driver, 'SELECT id, identity, purpose, secret_hash, CAST(expires_at AS TEXT) AS expires_text, CAST(used_at AS TEXT) AS used_text, CAST(created_at AS TEXT) AS created_text FROM authn_secret ORDER BY id')) as SecretRowText[];
}

/** Lets an expired row through the Node check, so only the SQL guard can refuse it. */
class NoNodeCheckSecretStore extends DbSecretStore {
  protected override liveInNode(): boolean {
    return true;
  }
}

for (const kind of DB_KINDS) {
  describe(`DbSecretStore conformance (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'secret_conf');
    });

    after(async () => {
      await db?.dispose();
    });

    runSecretStoreConformance(
      async () => {
        await rawQuery(db.driver, 'DELETE FROM authn_secret', [], QueryContext.Delete);
        return {
          secrets: new DbSecretStore(db.driver),
          secretStorage: {
            rows: async () =>
              (await secretRows(db)).map((r) => ({
                identity: parseIdentityKey(r.identity),
                purpose: r.purpose,
                hash: r.secret_hash,
                expiresAt: fromUtcColumn(r.expires_text)!,
                usedAt: fromUtcColumn(r.used_text) ?? null,
              })),
          },
          seed: fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore()),
        };
      },
      { title: `secret store conformance (${kind})`, timeoutMs: 30000 },
    );
  });

  describe(`DbSecretStore store (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let clock: FakeClock;

    before(async function () {
      db = await bootDb(this, kind, 'secret_store');
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authn_secret', [], QueryContext.Delete);
      clock = new FakeClock(T0);
      clock.install();
    });

    afterEach(() => {
      clock.uninstall();
    });

    it("issues and redeems N7's key-challenge secrets", async () => {
      expect(KID).to.have.length(64);
      expect(CHALLENGE).to.have.length(30);
      const store = new DbSecretStore(db.driver);

      const raw = await store.issue(KEY, CHALLENGE, 60);

      expect(raw).to.match(/^[A-Za-z0-9_-]{43}$/);
      const [row] = await secretRows(db);
      expect(row.identity).to.eq(`key:${KID}`);
      expect(row.purpose).to.eq(CHALLENGE);
      expect(await store.redeem(KEY, CHALLENGE, raw)).to.eq(true);
      expect(await store.redeem(KEY, CHALLENGE, raw)).to.eq(false);
    });

    it('writes UTC wall-clock times', async () => {
      await new DbSecretStore(db.driver).issue(ALICE, 'reset', 90);
      const [row] = await secretRows(db);
      expect(fromUtcColumn(row.created_text)?.toISOString()).to.eq(T0.toISOString());
      expect(fromUtcColumn(row.expires_text)?.toISOString()).to.eq(new Date(T0.getTime() + 90_000).toISOString());
      expect(row.used_text).to.eq(null);
    });

    it('throws InvalidArgument on a 33-char purpose and a 101-char identity', async () => {
      const store = new DbSecretStore(db.driver);
      const longId: IdentityRef = { type: 'user', id: 'x'.repeat(96) };
      expect(`user:${longId.id}`).to.have.length(101);
      await expectInvalid(store.issue(ALICE, 'p'.repeat(33), 60));
      await expectInvalid(store.issue(longId, 'reset', 60));
      await expectInvalid(store.redeem(ALICE, 'p'.repeat(33), 'x'));
      await expectInvalid(store.redeem(longId, 'reset', 'x'));
      await expectInvalid(store.issue({ type: '', id: 'a' }, 'reset', 60));
      await expectInvalid(store.issue({ type: 'a:b', id: 'a' }, 'reset', 60));
      await expectInvalid(store.issue(ALICE, '', 60));
      expect(await secretRows(db)).to.deep.eq([]);
    });

    it('throws InvalidArgument on a ttl that is not a positive number', async () => {
      const store = new DbSecretStore(db.driver);
      for (const ttl of [0, -1, NaN, Infinity, '60' as unknown as number]) {
        await expectInvalid(store.issue(ALICE, 'reset', ttl));
      }
    });

    it('answers false for a raw value that is not a string', async () => {
      const store = new DbSecretStore(db.driver);
      await store.issue(ALICE, 'reset', 60);
      expect(await store.redeem(ALICE, 'reset', undefined as unknown as string)).to.eq(false);
      expect(await store.redeem(ALICE, 'reset', 42 as unknown as string)).to.eq(false);
    });

    it('lets exactly one of 20 parallel redeems of one secret win', async () => {
      const store = new DbSecretStore(db.driver);
      const raw = await store.issue(ALICE, 'reset', 60);

      const results = await Promise.all(Array.from({ length: 20 }, () => store.redeem(ALICE, 'reset', raw)));

      expect(results.filter((r) => r)).to.have.length(1);
    });

    it('refuses an expired secret in SQL even when the Node check passes it', async () => {
      const store = new NoNodeCheckSecretStore(db.driver);
      const raw = await store.issue(ALICE, 'reset', 60);
      clock.tick(60_000);

      expect(await store.redeem(ALICE, 'reset', raw)).to.eq(false);

      const [row] = await secretRows(db);
      expect(row.used_text).to.eq(null);
    });

    it('SR-09 a secret store row holds only the SHA-256 of the secret', async () => {
      const store = new DbSecretStore(db.driver);
      const raw = await store.issue(ALICE, 'invite', 60);

      const all = (await rawQuery(db.driver, 'SELECT * FROM authn_secret')) as Record<string, unknown>[];
      expect(all).to.have.length(1);
      expect(all[0].secret_hash).to.eq(sha256hex(raw));
      const text = JSON.stringify(all);
      for (const part of [raw, raw.slice(0, 16), raw.slice(-16), Buffer.from(raw, 'base64url').toString('hex').slice(0, 16)]) {
        expect(text).to.not.contain(part);
      }
    });

    it('binds a secret to its identity and purpose in SQL', async () => {
      const store = new DbSecretStore(db.driver);
      const raw = await store.issue(ALICE, 'reset', 60);
      expect(await store.redeem(BOB, 'reset', raw)).to.eq(false);
      expect(await store.redeem(ALICE, 'invite', raw)).to.eq(false);
      expect(await store.redeem(ALICE, 'reset', raw + 'x')).to.eq(false);
      expect(await store.redeem(ALICE, 'reset', raw)).to.eq(true);
    });

    it('purges spent and expired rows only', async () => {
      const store = new DbSecretStore(db.driver);
      const spent = await store.issue(ALICE, 'reset', 3600);
      await store.redeem(ALICE, 'reset', spent);
      await store.issue(ALICE, 'invite', 30);
      const live = await store.issue(BOB, 'reset', 3600);
      clock.tick(31_000);

      expect(await store.purge()).to.eq(2);

      const left = await secretRows(db);
      expect(left.map((r) => [r.identity, r.purpose])).to.deep.eq([[`user:${BOB.id}`, 'reset']]);
      expect(await store.redeem(BOB, 'reset', live)).to.eq(true);
    });

    it("resolves the Orm's default connection from its container when given no driver", async () => {
      const store = new DbSecretStore(undefined, { container: db.container });
      const raw = await store.issue(ALICE, 'reset', 60);
      expect(await secretRows(db)).to.have.length(1);
      expect(await store.redeem(ALICE, 'reset', raw)).to.eq(true);
    });
  });
}
