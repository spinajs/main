import 'mocha';
import { expect } from 'chai';
import { pbkdf2Sync } from 'node:crypto';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import type { AuthnContext, Credentials, IdentityRef } from '@spinajs/authn/contracts';
import { FakeIdentityStore, MemoryPasswordCredentialStore } from '@spinajs/authn-testing';

import { Argon2PasswordHasher, Argon2PasswordHasherOptions } from '../src/hasher.js';
import { HasherBusy } from '../src/limiter.js';
import { AUTHN_LOCAL_CONFIGURATION_SCHEMA } from '../src/schema.js';
import { LocalPasswordStrategy } from '../src/strategy.js';
import { boot, disposeBooted, readingFrom, violationsOf } from './support/config-boot.js';

const ARGON2_DEFAULT_PREFIX = '$argon2id$v=19$m=65536,t=3,p=4$';
const LOGIN = 'alice@example.com';
const PASSWORD = 'Correct-Horse-9';
const WRONG = 'Wrong-Horse-9';
const CTX: AuthnContext = { now: new Date('2026-10-03T12:00:00Z'), purpose: 'login', ip: '203.0.113.7' };
const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_LOCAL_CONFIGURATION_SCHEMA];

// bcryptjs.hash(PASSWORD, 10)
const BCRYPT = '$2b$10$2AaUsf3/ZyvxvSkkuGeU1OchXgve7qmgemxnMKkc8Nfne.HIHb29a';
// pbkdf2-hmac-sha256, 1000 iterations, 32-byte key, standard base64 salt and hash
const PBKDF2 = '$pbkdf2-sha256$1000$c2FsdHNhbHRzYWx0MTY=$uYwqs0i89/hSfZ2EqibuMDgwkpQP2RuwM3xmCBBTXEM=';

const pw = (login: unknown, password: unknown): Credentials => ({ kind: 'password', login, password });

async function hasher(options: Argon2PasswordHasherOptions = {}) {
  const h = new Argon2PasswordHasher(options);
  await h.resolve();
  return h;
}

async function runs(h: Argon2PasswordHasher, f: () => Promise<unknown>): Promise<number> {
  const before = h.limiter.runs;
  await f();
  return h.limiter.runs - before;
}

describe('legacy password hashes', function () {
  this.timeout(60_000);

  describe('bcrypt', () => {
    it('verifies the right password and refuses a wrong one', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt'] });
      expect(await h.verify(BCRYPT, PASSWORD)).to.equal(true);
      expect(await h.verify(BCRYPT, WRONG)).to.equal(false);
      expect(await h.verify(BCRYPT, '')).to.equal(false);
    });

    it('verifies the $2a$ and $2y$ spellings of the same hash', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt'] });
      for (const prefix of ['$2a$', '$2y$']) {
        const stored = prefix + BCRYPT.slice(4);
        expect(await h.verify(stored, PASSWORD), prefix).to.equal(true);
        expect(await h.verify(stored, WRONG), prefix).to.equal(false);
      }
    });

    it('does not verify when legacyHashes is empty or names only pbkdf2', async () => {
      for (const legacyHashes of [undefined, [], ['pbkdf2' as const]]) {
        const h = await hasher({ legacyHashes });
        expect(await h.verify(BCRYPT, PASSWORD), JSON.stringify(legacyHashes)).to.equal(false);
      }
    });

    it('needs a rehash', async () => {
      expect((await hasher({ legacyHashes: ['bcrypt'] })).needsRehash(BCRYPT)).to.equal(true);
    });
  });

  describe('pbkdf2', () => {
    it('verifies the right password and refuses a wrong one', async () => {
      const h = await hasher({ legacyHashes: ['pbkdf2'] });
      expect(await h.verify(PBKDF2, PASSWORD)).to.equal(true);
      expect(await h.verify(PBKDF2, WRONG)).to.equal(false);
    });

    it('verifies an unpadded hash and a hash made at another iteration count', async () => {
      const h = await hasher({ legacyHashes: ['pbkdf2'] });
      expect(await h.verify(PBKDF2.replace(/=/g, ''), PASSWORD)).to.equal(true);

      const salt = Buffer.from('another salt value');
      const key = pbkdf2Sync(PASSWORD, salt, 25_000, 24, 'sha256');
      const stored = `$pbkdf2-sha256$25000$${salt.toString('base64')}$${key.toString('base64')}`;
      expect(await h.verify(stored, PASSWORD)).to.equal(true);
      expect(await h.verify(stored, WRONG)).to.equal(false);
    });

    it('does not verify when legacyHashes is empty or names only bcrypt', async () => {
      for (const legacyHashes of [undefined, [], ['bcrypt' as const]]) {
        const h = await hasher({ legacyHashes });
        expect(await h.verify(PBKDF2, PASSWORD), JSON.stringify(legacyHashes)).to.equal(false);
      }
    });

    it('needs a rehash', async () => {
      expect((await hasher({ legacyHashes: ['pbkdf2'] })).needsRehash(PBKDF2)).to.equal(true);
    });
  });

  describe('both formats enabled', () => {
    it('verifies each, and argon2 still verifies', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt', 'pbkdf2'] });
      expect(await h.verify(BCRYPT, PASSWORD)).to.equal(true);
      expect(await h.verify(PBKDF2, PASSWORD)).to.equal(true);
      const fresh = await h.hash(PASSWORD);
      expect(await h.verify(fresh, PASSWORD)).to.equal(true);
      expect(h.needsRehash(fresh)).to.equal(false);
    });

    it('a legacy hash is not read under a pepper tag', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt', 'pbkdf2'], pepper: { secret: 'pepper-0123456789abcdef', version: 2 } });
      expect(await h.verify(`$sp2$${BCRYPT}`, PASSWORD)).to.equal(false);
      expect(await h.verify(`$sp2$${PBKDF2}`, PASSWORD)).to.equal(false);
    });

    it('a legacy hash verifies unpeppered under a configured pepper and needs a rehash', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt'], pepper: { secret: 'pepper-0123456789abcdef', version: 2 } });
      expect(await h.verify(BCRYPT, PASSWORD)).to.equal(true);
      expect(h.needsRehash(BCRYPT)).to.equal(true);
    });
  });

  describe('malformed legacy strings', () => {
    const MALFORMED = [
      '$2b$10$abc',
      '$2b$10$' + 'a'.repeat(53) + '!',
      '$2b$99$' + 'a'.repeat(53),
      '$2b$10$',
      '$2c$10$' + 'a'.repeat(53),
      '$pbkdf2-sha256$',
      '$pbkdf2-sha256$x$c2FsdA==$aGFzaA==',
      '$pbkdf2-sha256$0$c2FsdA==$aGFzaA==',
      '$pbkdf2-sha256$-5$c2FsdA==$aGFzaA==',
      '$pbkdf2-sha256$1000$$aGFzaA==',
      '$pbkdf2-sha256$1000$c2FsdA==$',
      '$pbkdf2-sha256$1000$c2FsdA==',
      '$pbkdf2-sha256$99999999999999$c2FsdA==$aGFzaA==',
      '$pbkdf2-sha1$1000$c2FsdA==$aGFzaA==',
      '$pbkdf2-sha256$1000$c2Fs dA==$aGFzaA==',
    ];

    it('fail without throwing, with every format enabled', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt', 'pbkdf2'] });
      for (const stored of MALFORMED) {
        expect(await h.verify(stored, PASSWORD), stored).to.equal(false);
      }
    });

    it('cost the same limiter work as a real verify', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt', 'pbkdf2'] });
      const real = await runs(h, () => h.verify(BCRYPT, PASSWORD));
      for (const stored of MALFORMED) {
        expect(await runs(h, () => h.verify(stored, PASSWORD)), stored).to.equal(real);
      }
    });

    it('a tampered hash part fails', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt', 'pbkdf2'] });
      expect(await h.verify(PBKDF2.replace('uYwq', 'uYwr'), PASSWORD)).to.equal(false);
      expect(await h.verify(BCRYPT.slice(0, 40) + (BCRYPT[40] === 'a' ? 'b' : 'a') + BCRYPT.slice(41), PASSWORD)).to.equal(false);
    });
  });

  describe('the limiter (PERF-6)', () => {
    it('every legacy verify, right or wrong, takes one limiter slot', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt', 'pbkdf2'] });
      expect(await runs(h, () => h.verify(BCRYPT, PASSWORD))).to.equal(1);
      expect(await runs(h, () => h.verify(BCRYPT, WRONG))).to.equal(1);
      expect(await runs(h, () => h.verify(PBKDF2, PASSWORD))).to.equal(1);
      expect(await runs(h, () => h.verify(PBKDF2, WRONG))).to.equal(1);
    });

    it('a format that is not enabled costs the same single slot', async () => {
      const h = await hasher({ legacyHashes: [] });
      expect(await runs(h, () => h.verify(BCRYPT, PASSWORD))).to.equal(1);
      expect(await runs(h, () => h.verify(PBKDF2, PASSWORD))).to.equal(1);
    });

    it('never more than maxConcurrent legacy verifies run at once', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt', 'pbkdf2'], maxConcurrent: 2, maxQueue: 16 });
      const before = h.limiter.runs;
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => h.verify(i % 2 ? BCRYPT : PBKDF2, PASSWORD)));
      expect(results.every(Boolean)).to.equal(true);
      expect(h.limiter.runs - before).to.equal(8);
      expect(h.limiter.peak).to.be.at.most(2);
    });

    it('a full limiter refuses a legacy verify with HasherBusy', async () => {
      const h = await hasher({ legacyHashes: ['bcrypt', 'pbkdf2'], maxConcurrent: 1, maxQueue: 0 });
      let release!: () => void;
      const held = h.limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
      try {
        for (const stored of [BCRYPT, PBKDF2]) {
          let thrown: unknown;
          await h.verify(stored, PASSWORD).catch((e: unknown) => {
            thrown = e;
          });
          expect(thrown, stored).to.be.instanceOf(HasherBusy);
        }
      } finally {
        release();
        await held;
      }
    });
  });

  describe('login rehash (A03, A30)', () => {
    class RecordingStore extends MemoryPasswordCredentialStore {
      public readonly sets: { hash: string; expected: string | null | undefined }[] = [];
      public concurrent: string | null = null;
      public async set(id: IdentityRef, hash: string, expected?: string | null): Promise<boolean> {
        this.sets.push({ hash, expected });
        if (this.concurrent !== null) {
          await super.set(id, this.concurrent);
        }
        return super.set(id, hash, expected);
      }
    }

    async function setup(options: Argon2PasswordHasherOptions, stored: string) {
      const identities = new FakeIdentityStore();
      const passwords = new RecordingStore();
      const h = await hasher(options);
      const strategy = new LocalPasswordStrategy({ identities, passwords, hasher: h, log: { warn: () => undefined } });
      await strategy.resolve();
      const alice = identities.add({ login: LOGIN, email: LOGIN });
      await passwords.set(alice, stored);
      passwords.sets.length = 0;
      passwords.writes.length = 0;
      return { strategy, passwords, hasher: h, alice };
    }

    for (const [kind, fixture] of [
      ['bcrypt', BCRYPT],
      ['pbkdf2', PBKDF2],
    ] as const) {
      it(`a ${kind} login rewrites the stored hash as argon2, over the verified value`, async () => {
        const { strategy, passwords, hasher: h, alice } = await setup({ legacyHashes: [kind] }, fixture);

        expect(await strategy.verify(pw(LOGIN, PASSWORD), CTX)).to.deep.equal({ ok: true, identity: alice, method: 'password' });

        const stored = await passwords.get(alice);
        expect(stored!.startsWith(ARGON2_DEFAULT_PREFIX), stored!).to.equal(true);
        expect(await h.verify(stored, PASSWORD)).to.equal(true);
        expect(passwords.sets).to.have.length(1);
        expect(passwords.sets[0].expected).to.equal(fixture);
      });

      it(`a second ${kind} login finds argon2 and writes nothing`, async () => {
        const { strategy, passwords } = await setup({ legacyHashes: [kind] }, fixture);
        await strategy.verify(pw(LOGIN, PASSWORD), CTX);
        passwords.writes.length = 0;

        expect((await strategy.verify(pw(LOGIN, PASSWORD), CTX)).ok).to.equal(true);
        expect(passwords.writes).to.have.length(0);
      });

      it(`a wrong password against a ${kind} hash fails and leaves it`, async () => {
        const { strategy, passwords, alice } = await setup({ legacyHashes: [kind] }, fixture);

        expect(await strategy.verify(pw(LOGIN, WRONG), CTX)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
        expect(await passwords.get(alice)).to.equal(fixture);
        expect(passwords.writes).to.have.length(0);
      });

      it(`with legacyHashes empty the ${kind} login fails and leaves the hash`, async () => {
        const { strategy, passwords, alice } = await setup({ legacyHashes: [] }, fixture);

        expect(await strategy.verify(pw(LOGIN, PASSWORD), CTX)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
        expect(await passwords.get(alice)).to.equal(fixture);
        expect(passwords.writes).to.have.length(0);
      });
    }

    it('a value stored meanwhile is not overwritten by the rehash (A30)', async () => {
      const { strategy, passwords, hasher: h, alice } = await setup({ legacyHashes: ['bcrypt'] }, BCRYPT);
      const newer = await h.hash('Newer-Horse-9');
      passwords.concurrent = newer;

      expect((await strategy.verify(pw(LOGIN, PASSWORD), CTX)).ok).to.equal(true);
      expect(await passwords.get(alice)).to.equal(newer);
    });

    it('a rehash under a pepper stores the peppered hash', async () => {
      const { strategy, passwords, alice } = await setup({ legacyHashes: ['bcrypt'], pepper: { secret: 'pepper-0123456789abcdef', version: 5 } }, BCRYPT);

      expect((await strategy.verify(pw(LOGIN, PASSWORD), CTX)).ok).to.equal(true);
      expect((await passwords.get(alice))!.startsWith(`$sp5$${ARGON2_DEFAULT_PREFIX}`)).to.equal(true);
    });

    it('a full limiter answers the busy outcome and keeps the legacy hash', async () => {
      const { strategy, passwords, hasher: h, alice } = await setup({ legacyHashes: ['bcrypt'], maxConcurrent: 1, maxQueue: 0 }, BCRYPT);
      let release!: () => void;
      const held = h.limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
      try {
        const outcome = await strategy.verify(pw(LOGIN, PASSWORD), CTX);
        expect(outcome.ok).to.equal(false);
        expect((outcome as { reason: string }).reason).to.equal('throttled');
      } finally {
        release();
        await held;
      }
      expect(await passwords.get(alice)).to.equal(BCRYPT);
    });
  });

  describe('configuration', () => {
    afterEach(disposeBooted);

    it('defaults to an empty list', async () => {
      const { configuration } = await boot(SCHEMAS, { authn: { local: {} } });
      expect(configuration.get('authn.local.legacyHashes')).to.deep.equal([]);
    });

    it('accepts bcrypt and pbkdf2', async () => {
      expect(await violationsOf(SCHEMAS, { authn: { local: { legacyHashes: ['bcrypt', 'pbkdf2'] } } })).to.deep.equal([]);
    });

    it('refuses an unknown format, a duplicate and a non-list', async () => {
      for (const legacyHashes of [['md5'], ['bcrypt', 'bcrypt'], 'bcrypt', [1]]) {
        const paths = await violationsOf(SCHEMAS, { authn: { local: { legacyHashes } } });
        expect(paths.some((p) => p.startsWith('authn.local.legacyHashes')), JSON.stringify(legacyHashes)).to.equal(true);
      }
    });

    it('is read by a hasher resolved from the configuration', async () => {
      const { child } = await boot(SCHEMAS, { authn: { local: { legacyHashes: ['bcrypt'] } } });
      const h = readingFrom(new Argon2PasswordHasher(), child);
      await h.resolve();
      expect(await h.verify(BCRYPT, PASSWORD)).to.equal(true);
      expect(await h.verify(PBKDF2, PASSWORD)).to.equal(false);
    });
  });
});
