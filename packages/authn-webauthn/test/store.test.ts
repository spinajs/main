import 'mocha';
import assert from 'node:assert/strict';

import { WebAuthnCredentialExists, WebAuthnCredentialStore } from '../src/contracts.js';
import type { WebAuthnCredential } from '../src/contracts.js';
import { MemoryWebAuthnChallengeStore, WebAuthnChallengeStore, newChallenge } from '../src/challenge.js';
import { MemoryWebAuthnCredentialStore } from '../src/store/index.js';
import { DbWebAuthnChallengeStore, DbWebAuthnCredentialStore } from '../src/db.js';
import { ALICE, BOB, START } from './support/fixtures.js';
import { bootSqlite, clearTables } from './support/sqlite.js';
import type { SqliteDb } from './support/sqlite.js';

interface StoreKind {
  readonly name: string;
  before?(): Promise<void>;
  after?(): Promise<void>;
  credentials(): Promise<WebAuthnCredentialStore>;
  challenges(): Promise<WebAuthnChallengeStore>;
}

let sqlite: SqliteDb | undefined;

const KINDS: StoreKind[] = [
  {
    name: 'memory',
    credentials: async () => new MemoryWebAuthnCredentialStore(),
    challenges: async () => new MemoryWebAuthnChallengeStore(),
  },
  {
    name: 'ORM (sqlite)',
    before: async () => {
      sqlite = await bootSqlite('store');
    },
    after: async () => {
      await sqlite?.dispose();
    },
    credentials: async () => {
      await clearTables(sqlite!.driver);
      return new DbWebAuthnCredentialStore();
    },
    challenges: async () => {
      await clearTables(sqlite!.driver);
      return new DbWebAuthnChallengeStore();
    },
  },
];

const credential = (over: Partial<WebAuthnCredential> = {}): WebAuthnCredential => ({
  credentialId: 'Y3JlZC0x',
  identity: ALICE,
  publicKey: new Uint8Array([0xa4, 1, 1, 3, 0x27, 0x20, 6, 0x21, 0x58, 0x20, ...new Array<number>(32).fill(7)]),
  counter: 0,
  transports: ['internal', 'hybrid'],
  aaguid: '6b69742d-736f-6674-2d61-757468656e00',
  name: 'Laptop',
  createdAt: new Date('2026-10-21T10:00:00.000Z'),
  ...over,
});

for (const kind of KINDS)
  describe(`credential and challenge stores: ${kind.name}`, function () {
    this.timeout(30000);

    before(async () => {
      await kind.before?.();
    });

    after(async () => {
      await kind.after?.();
    });

    describe('WebAuthnCredentialStore', () => {
      let store: WebAuthnCredentialStore;

      beforeEach(async () => {
        store = await kind.credentials();
      });

      it('add and get round-trip every field', async () => {
        const c = credential();
        await store.add(c);
        const got = await store.get(c.credentialId);
        assert.ok(got);
        assert.deepStrictEqual({ ...got, publicKey: [...got.publicKey], transports: [...(got.transports ?? [])], identity: { ...got.identity } }, { ...c, publicKey: [...c.publicKey], transports: [...c.transports!], identity: { ...c.identity } });
      });

      it('get is null for an unknown credential id', async () => {
        assert.strictEqual(await store.get('bm9uZQ'), null);
      });

      it('add refuses a credential id that is taken, by any identity', async () => {
        await store.add(credential());
        await assert.rejects(store.add(credential({ identity: BOB, name: 'Other' })), WebAuthnCredentialExists);
        assert.deepStrictEqual((await store.get('Y3JlZC0x'))?.identity, ALICE);
      });

      it('advance with the wrong expected counter is false and changes nothing', async () => {
        await store.add(credential({ counter: 5 }));
        const at = new Date('2026-10-21T11:00:00.000Z');
        assert.strictEqual(await store.advance('Y3JlZC0x', 4, 6, at), false);
        assert.strictEqual(await store.advance('Y3JlZC0x', 6, 7, at), false);
        const got = await store.get('Y3JlZC0x');
        assert.strictEqual(got?.counter, 5);
        assert.strictEqual(got?.lastUsedAt, undefined);
      });

      it('advance with the expected counter moves it once and records the use', async () => {
        await store.add(credential({ counter: 5 }));
        const at = new Date('2026-10-21T11:00:00.000Z');
        assert.strictEqual(await store.advance('Y3JlZC0x', 5, 6, at), true);
        assert.strictEqual(await store.advance('Y3JlZC0x', 5, 6, at), false, 'a second advance from the same counter');
        const got = await store.get('Y3JlZC0x');
        assert.strictEqual(got?.counter, 6);
        assert.strictEqual(got?.lastUsedAt?.toISOString(), at.toISOString());
      });

      it('advance of an unknown credential is false', async () => {
        assert.strictEqual(await store.advance('bm9uZQ', 0, 1, START), false);
      });

      it('listFor isolates identities', async () => {
        await store.add(credential({ credentialId: 'YWxpY2UtMQ', createdAt: new Date('2026-10-21T10:00:00.000Z') }));
        await store.add(credential({ credentialId: 'YWxpY2UtMg', createdAt: new Date('2026-10-21T10:05:00.000Z') }));
        await store.add(credential({ credentialId: 'Ym9iLTE', identity: BOB }));
        assert.deepStrictEqual(
          (await store.listFor(ALICE)).map((c) => c.credentialId),
          ['YWxpY2UtMQ', 'YWxpY2UtMg'],
        );
        assert.deepStrictEqual(
          (await store.listFor(BOB)).map((c) => c.credentialId),
          ['Ym9iLTE'],
        );
        assert.deepStrictEqual(await store.listFor({ type: 'user', id: 'nobody' }), []);
      });

      it('remove takes only a credential of the identity', async () => {
        await store.add(credential());
        assert.strictEqual(await store.remove(BOB, 'Y3JlZC0x'), false);
        assert.ok(await store.get('Y3JlZC0x'));
        assert.strictEqual(await store.remove(ALICE, 'Y3JlZC0x'), true);
        assert.strictEqual(await store.get('Y3JlZC0x'), null);
        assert.strictEqual(await store.remove(ALICE, 'Y3JlZC0x'), false);
      });

      it('a returned credential does not change the stored one', async () => {
        await store.add(credential());
        const got = (await store.get('Y3JlZC0x'))!;
        got.publicKey[0] = 0;
        got.createdAt.setTime(0);
        const again = (await store.get('Y3JlZC0x'))!;
        assert.strictEqual(again.publicKey[0], 0xa4);
        assert.strictEqual(again.createdAt.toISOString(), '2026-10-21T10:00:00.000Z');
      });
    });

    describe('WebAuthnChallengeStore', () => {
      let store: WebAuthnChallengeStore;

      beforeEach(async () => {
        store = await kind.challenges();
      });

      it('take gives a challenge once', async () => {
        const c = newChallenge('register', START, 300, ALICE);
        await store.put(c);
        const taken = await store.take(c.id, START);
        assert.ok(taken);
        assert.deepStrictEqual({ ...taken, identity: { ...taken.identity }, expiresAt: taken.expiresAt.toISOString() }, { ...c, identity: { ...c.identity }, expiresAt: c.expiresAt.toISOString() });
        assert.strictEqual(await store.take(c.id, START), null);
      });

      it('a login challenge has no identity', async () => {
        const c = newChallenge('login', START, 300);
        await store.put(c);
        const taken = await store.take(c.id, START);
        assert.strictEqual(taken?.purpose, 'login');
        assert.strictEqual(taken?.identity, undefined);
      });

      it('take is null for an expired challenge', async () => {
        const c = newChallenge('login', START, 300);
        await store.put(c);
        assert.strictEqual(await store.take(c.id, new Date(START.getTime() + 301_000)), null);
      });

      it('take is null for an unknown id', async () => {
        assert.strictEqual(await store.take('bm9uZQ', START), null);
      });
    });
  });

describe('newChallenge', () => {
  it('draws a fresh 128-bit id and 256-bit challenge each time, live for the ttl', () => {
    const a = newChallenge('login', START, 300);
    const b = newChallenge('login', START, 300);
    assert.notStrictEqual(a.id, b.id);
    assert.notStrictEqual(a.challenge, b.challenge);
    assert.strictEqual(Buffer.from(a.id, 'base64url').length, 16);
    assert.strictEqual(Buffer.from(a.challenge, 'base64url').length, 32);
    assert.strictEqual(a.expiresAt.getTime(), START.getTime() + 300_000);
  });
});
