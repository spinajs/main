import { FakeClock, FakeIdentityStore, MemoryPasswordCredentialStore, fakeSeedPort, runLinkStoreConformance } from '@spinajs/authn-testing';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { DbIdentityLinkStore } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const T0 = new Date('2026-06-01T10:00:00.000Z');
const ALICE: IdentityRef = { type: 'user', id: '0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10' };
const BOB: IdentityRef = { type: 'user', id: '5e0d7f3a-2b44-4d8e-a1c9-6f2e8b3d0c21' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

for (const kind of DB_KINDS) {
  describe(`DbIdentityLinkStore conformance (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'link_conf');
    });

    after(async () => {
      await db?.dispose();
    });

    runLinkStoreConformance(
      async () => {
        await rawQuery(db.driver, 'DELETE FROM authn_identity', [], QueryContext.Delete);
        return { links: new DbIdentityLinkStore(db.driver), seed: fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore()) };
      },
      { title: `link store conformance (${kind})`, timeoutMs: 30000 },
    );
  });

  describe(`DbIdentityLinkStore store (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let clock: FakeClock;

    before(async function () {
      db = await bootDb(this, kind, 'link_store');
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authn_identity', [], QueryContext.Delete);
      clock = new FakeClock(T0);
      clock.install();
    });

    afterEach(() => {
      clock.uninstall();
    });

    it('links with a uuid v4 id, the time of the call and no optional fields unless set', async () => {
      const store = new DbIdentityLinkStore(db.driver);

      const link = await store.link(ALICE, { provider: 'oidc:g', subject: 's-1' });

      expect(link.id).to.match(UUID_V4);
      expect(link).to.deep.eq({ id: link.id, identity: ALICE, provider: 'oidc:g', subject: 's-1', linkedAt: T0 });
      expect(await store.find('oidc:g', 's-1')).to.deep.eq(link);
      expect(await store.list(ALICE)).to.deep.eq([link]);
    });

    it('stores the email, email_verified only when the provider says true, and no attributes', async () => {
      const store = new DbIdentityLinkStore(db.driver);
      const verified = await store.link(ALICE, { provider: 'oidc:g', subject: 'v', email: 'alice@example.test', emailVerified: true, claims: { a: 1 } });
      await store.link(ALICE, { provider: 'oidc:g', subject: 'u', email: 'alice@example.test' });

      expect(verified.email).to.eq('alice@example.test');
      expect((await store.find('oidc:g', 'v'))?.email).to.eq('alice@example.test');
      const rows = (await rawQuery(db.driver, 'SELECT subject, identity_type, identity_id, email_verified, attributes FROM authn_identity ORDER BY subject')) as Record<string, unknown>[];
      expect(rows.map((r) => [r.subject, r.identity_type, r.identity_id, Boolean(r.email_verified), r.attributes])).to.deep.eq([
        ['u', 'user', ALICE.id, false, null],
        ['v', 'user', ALICE.id, true, null],
      ]);
    });

    it('rejects a duplicate (provider, subject) with ResourceDuplicated', async () => {
      const store = new DbIdentityLinkStore(db.driver);
      await store.link(ALICE, { provider: 'oidc:g', subject: 'taken' });

      const err = await rejection(store.link(BOB, { provider: 'oidc:g', subject: 'taken' }));

      expect(err).to.be.instanceOf(ResourceDuplicated);
      expect((await store.find('oidc:g', 'taken'))?.identity).to.deep.eq(ALICE);
      expect(await store.list(BOB)).to.deep.eq([]);
    });

    it('touch sets lastUsedAt', async () => {
      const store = new DbIdentityLinkStore(db.driver);
      const link = await store.link(ALICE, { provider: 'oidc:g', subject: 's-1' });
      const later = new Date(T0.getTime() + 3_600_123);

      await store.touch(link.id, later);

      expect(await store.find('oidc:g', 's-1')).to.deep.eq({ ...link, lastUsedAt: later });
      clock.tick(5000);
      await store.touch(link.id);
      expect((await store.list(ALICE))[0].lastUsedAt).to.deep.eq(new Date(T0.getTime() + 5000));
    });

    it('lists only the links of that identity', async () => {
      const store = new DbIdentityLinkStore(db.driver);
      const a1 = await store.link(ALICE, { provider: 'p1', subject: 'x' });
      clock.tick(1000);
      const a2 = await store.link(ALICE, { provider: 'p2', subject: 'x' });
      await store.link(BOB, { provider: 'p3', subject: 'x' });
      await store.link({ type: 'service', id: ALICE.id }, { provider: 'p4', subject: 'x' });

      expect(await store.list(ALICE)).to.deep.eq([a1, a2]);
    });

    it('unlink of an unknown id does nothing', async () => {
      const store = new DbIdentityLinkStore(db.driver);
      await store.link(ALICE, { provider: 'p1', subject: 'x' });
      await store.unlink('00000000-0000-4000-8000-000000000000');
      expect(await store.list(ALICE)).to.have.length(1);
    });

    it('throws InvalidArgument on values longer than their columns, never cutting them', async () => {
      const store = new DbIdentityLinkStore(db.driver);
      const cases: [IdentityRef, { provider: string; subject: string; email?: string }][] = [
        [
          { type: 't'.repeat(17), id: 'a' },
          { provider: 'p', subject: 's' },
        ],
        [
          { type: 'user', id: 'i'.repeat(65) },
          { provider: 'p', subject: 's' },
        ],
        [
          { type: '', id: 'a' },
          { provider: 'p', subject: 's' },
        ],
        [
          { type: 'a:b', id: 'a' },
          { provider: 'p', subject: 's' },
        ],
        [ALICE, { provider: 'p'.repeat(129), subject: 's' }],
        [ALICE, { provider: 'p', subject: 's'.repeat(256) }],
        [ALICE, { provider: 'p', subject: 's', email: 'e'.repeat(256) }],
        [ALICE, { provider: '', subject: 's' }],
        [ALICE, { provider: 'p', subject: '' }],
      ];
      for (const [identity, external] of cases) {
        expect(await rejection(store.link(identity, external)), JSON.stringify([identity, external]).slice(0, 80)).to.be.instanceOf(InvalidArgument);
      }
      expect(await rejection(store.list({ type: 'user', id: 'i'.repeat(65) }))).to.be.instanceOf(InvalidArgument);
      expect(await rawQuery(db.driver, 'SELECT id FROM authn_identity')).to.deep.eq([]);
    });

    it("resolves the Orm's default connection from its container when given no driver", async () => {
      const store = new DbIdentityLinkStore(undefined, { container: db.container });
      const link = await store.link(ALICE, { provider: 'p', subject: 's' });
      expect(await new DbIdentityLinkStore(db.driver).find('p', 's')).to.deep.eq(link);
    });
  });
}
