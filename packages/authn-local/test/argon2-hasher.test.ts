import 'mocha';
import { expect } from 'chai';
import { createHmac } from 'node:crypto';
import * as argon2 from 'argon2';
import { DI } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import { Argon2PasswordHasher, EXPIRED_PASSWORD_MARKER, PasswordHasher } from '../src/hasher.js';
import { formatStored, parseStored, pepperInput } from '../src/pepper.js';

const ARGON2_DEFAULT_PREFIX = '$argon2id$v=19$m=65536,t=3,p=4$';
const PASSWORD = 'Correct-Horse-9';
const PEPPER_A = { secret: 'pepper-a-0123456789abcdef', version: 2 };
const PEPPER_B = { secret: 'pepper-b-0123456789abcdef', version: 2 };
const PEPPER_V1 = { secret: 'pepper-v1-0123456789abcdef', version: 1 };
const CHEAP = { memoryCost: 4096, timeCost: 2, parallelism: 1 };
// Passes parseStored, but argon2 refuses the 4-byte salt.
const ARGON2_REFUSES = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';

async function elapsedMs(f: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await f();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const median3 = (xs: number[]) => [...xs].sort((a, b) => a - b)[1];

async function hasher(options: ConstructorParameters<typeof Argon2PasswordHasher>[0] = {}) {
  const h = new Argon2PasswordHasher(options);
  await h.resolve();
  return h;
}

describe('Argon2PasswordHasher', function () {
  this.timeout(60_000);

  describe('without a pepper', () => {
    it('stores the argon2 library defaults (A03, H30)', async () => {
      const h = await hasher();
      const stored = await h.hash(PASSWORD);
      expect(stored.startsWith(ARGON2_DEFAULT_PREFIX), stored).to.equal(true);
    });

    it('verifies the right password and refuses a wrong one', async () => {
      const h = await hasher();
      const stored = await h.hash(PASSWORD);
      expect(await h.verify(stored, PASSWORD)).to.equal(true);
      expect(await h.verify(stored, 'Wrong-Horse-9')).to.equal(false);
    });

    it('is a PasswordHasher', async () => {
      expect(await hasher()).to.be.instanceOf(PasswordHasher);
    });
  });

  describe('with a pepper', () => {
    it('prefixes the pepper version and keeps the argon2 defaults after it', async () => {
      const h = await hasher({ pepper: PEPPER_A });
      const stored = await h.hash(PASSWORD);
      expect(stored.startsWith('$sp2$'), stored).to.equal(true);
      expect(stored.startsWith(`$sp2$${ARGON2_DEFAULT_PREFIX}`), stored).to.equal(true);
    });

    it('verifies the right password and refuses a wrong one', async () => {
      const h = await hasher({ pepper: PEPPER_A });
      const stored = await h.hash(PASSWORD);
      expect(await h.verify(stored, PASSWORD)).to.equal(true);
      expect(await h.verify(stored, 'Wrong-Horse-9')).to.equal(false);
    });

    it('a hash under pepper A does not verify under pepper B with the same version', async () => {
      const a = await hasher({ pepper: PEPPER_A });
      const b = await hasher({ pepper: PEPPER_B });
      const stored = await a.hash(PASSWORD);
      expect(await b.verify(stored, PASSWORD)).to.equal(false);
    });

    it('the argon2 input is the HMAC, not the password', async () => {
      const h = await hasher({ pepper: PEPPER_A });
      const plain = await hasher();
      const stored = await h.hash(PASSWORD);
      const parsed = parseStored(stored);
      expect(parsed).to.not.equal(null);
      expect(await plain.verify(parsed!.argon2, PASSWORD)).to.equal(false);
    });

    it('the argon2 input is the raw HMAC-SHA256 of the password keyed by the pepper (D2)', async () => {
      const h = await hasher({ pepper: PEPPER_A });
      const stored = await h.hash(PASSWORD);
      const input = createHmac('sha256', PEPPER_A.secret).update(PASSWORD, 'utf8').digest();
      expect(await argon2.verify(parseStored(stored)!.argon2, input)).to.equal(true);
    });

    it('pepperInput matches the RFC 4231 HMAC-SHA256 test case 2', () => {
      const out = pepperInput('what do ya want for nothing?', 'Jefe');
      expect(out).to.have.length(32);
      expect(out.toString('hex')).to.equal('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    });

    it('an unpeppered hash still verifies once a pepper is set', async () => {
      const plain = await hasher();
      const peppered = await hasher({ pepper: PEPPER_A });
      expect(await peppered.verify(await plain.hash(PASSWORD), PASSWORD)).to.equal(true);
    });
  });

  describe('previous peppers', () => {
    it('a version 1 hash verifies under version 2 when previous holds version 1, and needs a rehash', async () => {
      const old = await hasher({ pepper: PEPPER_V1 });
      const stored = await old.hash(PASSWORD);
      expect(stored.startsWith('$sp1$'), stored).to.equal(true);

      const h = await hasher({ pepper: { ...PEPPER_A, previous: [PEPPER_V1] } });
      expect(await h.verify(stored, PASSWORD)).to.equal(true);
      expect(await h.verify(stored, 'Wrong-Horse-9')).to.equal(false);
      expect(h.needsRehash(stored)).to.equal(true);
    });

    it('without the previous entry a version 1 hash does not verify', async () => {
      const old = await hasher({ pepper: PEPPER_V1 });
      const stored = await old.hash(PASSWORD);
      const h = await hasher({ pepper: PEPPER_A });
      expect(await h.verify(stored, PASSWORD)).to.equal(false);
    });

    it('a peppered hash verifies from previous while no pepper is current, and needs a rehash', async () => {
      const old = await hasher({ pepper: PEPPER_V1 });
      const stored = await old.hash(PASSWORD);
      const h = await hasher({ pepper: { secret: null, version: 1, previous: [PEPPER_V1] } });
      expect(await h.verify(stored, PASSWORD)).to.equal(true);
      expect(h.needsRehash(stored)).to.equal(true);
    });
  });

  describe('needsRehash', () => {
    it('is true for other argon2 parameters', async () => {
      const h = await hasher();
      const stored = await h.hashWith(PASSWORD, { argon2: CHEAP, pepper: null });
      expect(stored.startsWith('$argon2id$v=19$m=4096,t=2,p=1$'), stored).to.equal(true);
      expect(await h.verify(stored, PASSWORD)).to.equal(true);
      expect(h.needsRehash(stored)).to.equal(true);
    });

    it('is true for other argon2 parameters under the current pepper', async () => {
      const h = await hasher({ pepper: PEPPER_A });
      const stored = await h.hashWith(PASSWORD, { argon2: CHEAP });
      expect(stored.startsWith('$sp2$$argon2id$v=19$m=4096,t=2,p=1$'), stored).to.equal(true);
      expect(await h.verify(stored, PASSWORD)).to.equal(true);
      expect(h.needsRehash(stored)).to.equal(true);
    });

    it('is true for an unpeppered hash while a pepper is set', async () => {
      const h = await hasher({ pepper: PEPPER_A });
      const stored = await h.hashWith(PASSWORD, { pepper: null });
      expect(stored.startsWith(ARGON2_DEFAULT_PREFIX), stored).to.equal(true);
      expect(h.needsRehash(stored)).to.equal(true);
    });

    it('is true for a peppered hash while no pepper is set', async () => {
      const h = await hasher();
      const stored = await h.hashWith(PASSWORD, { pepper: PEPPER_V1 });
      expect(h.needsRehash(stored)).to.equal(true);
    });

    it('is true for a non-argon2id hash at the default parameters', async () => {
      const h = await hasher();
      const stored = await h.hash(PASSWORD);
      expect(h.needsRehash(stored.replace('$argon2id$', '$argon2i$'))).to.equal(true);
    });

    it('is false for a current hash, with and without a pepper', async () => {
      const plain = await hasher();
      expect(plain.needsRehash(await plain.hash(PASSWORD))).to.equal(false);
      const peppered = await hasher({ pepper: PEPPER_A });
      expect(peppered.needsRehash(await peppered.hash(PASSWORD))).to.equal(false);
    });

    it('is true for values that cannot verify', async () => {
      const h = await hasher();
      for (const v of ['', 'garbage', EXPIRED_PASSWORD_MARKER, '$sp9$$argon2id$v=19$m=65536,t=3,p=4$x$y']) {
        expect(h.needsRehash(v), v).to.equal(true);
      }
    });
  });

  describe('values that never verify still cost an argon2 verify', () => {
    const values: readonly [string, string | null | undefined][] = [
      ['null', null],
      ['undefined', undefined],
      ['empty', ''],
      ['the expired marker', EXPIRED_PASSWORD_MARKER],
      ['garbage', 'not-a-hash'],
      ['a bcrypt hash', '$2b$10$abcdefghijklmnopqrstuuJ6E1cZ7uYV2lZ1cQyQ1G7r8bQ7m7xS2'],
      ['a truncated argon2 hash', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA'],
      ['an argon2 hash with bad base64', '$argon2id$v=19$m=65536,t=3,p=4$!!!$!!!'],
      ['an unknown pepper version', '$sp7$$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
      ['a malformed pepper tag', '$spX$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$aGFzaA'],
      ['an argon2 hash argon2 itself refuses', ARGON2_REFUSES],
    ];

    for (const [label, stored] of values) {
      it(label, async () => {
        const h = await hasher({ pepper: PEPPER_A });
        const before = h.limiter.runs;
        expect(await h.verify(stored, PASSWORD)).to.equal(false);
        expect(h.limiter.runs - before).to.equal(1);
      });
    }

    it('the expired marker also never verifies without a pepper', async () => {
      const h = await hasher();
      const before = h.limiter.runs;
      expect(await h.verify(EXPIRED_PASSWORD_MARKER, EXPIRED_PASSWORD_MARKER)).to.equal(false);
      expect(h.limiter.runs - before).to.equal(1);
    });

    for (const [label, stored] of [
      ['null', null],
      ['an argon2 hash argon2 itself refuses', ARGON2_REFUSES],
    ] as const) {
      it(`${label} takes about as long as a real wrong-password verify`, async () => {
        const h = await hasher({ pepper: PEPPER_A });
        const real = await h.hash(PASSWORD);
        const realMs: number[] = [];
        const dummyMs: number[] = [];
        for (let i = 0; i < 3; i++) {
          realMs.push(await elapsedMs(() => h.verify(real, 'Wrong-Horse-9')));
          dummyMs.push(await elapsedMs(() => h.verify(stored, 'Wrong-Horse-9')));
        }
        // Measured ratio is about 1.1; 0.5 only catches a skipped argon2 verify.
        expect(median3(dummyMs), `real ${realMs} dummy ${dummyMs}`).to.be.greaterThan(median3(realMs) * 0.5);
      });
    }

    it('works before resolve() was called', async () => {
      const h = new Argon2PasswordHasher({});
      expect(await h.verify(null, PASSWORD)).to.equal(false);
    });
  });

  describe('concurrency cap', () => {
    it('SR-03 at most maxConcurrent hashes run', async () => {
      const h = await hasher({ maxConcurrent: 2 });
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => h.hash(`Kit-Pass-${i}-xyz`)));
      expect(results.filter((r) => r.status === 'fulfilled')).to.have.length(8);
      expect(h.limiter.peak).to.equal(2);
    });

    it('verifies, dummy verifies included, share the cap', async () => {
      const h = await hasher({ maxConcurrent: 2 });
      const stored = await h.hash(PASSWORD);
      const results = await Promise.all([...Array.from({ length: 3 }, () => h.verify(stored, PASSWORD)), ...Array.from({ length: 3 }, () => h.verify(null, PASSWORD)), h.hash(PASSWORD)]);
      expect(results.slice(0, 3)).to.deep.equal([true, true, true]);
      expect(results.slice(3, 6)).to.deep.equal([false, false, false]);
      expect(h.limiter.peak).to.equal(2);
    });

    it('defaults to 8', async () => {
      const h = await hasher();
      expect(h.limiter.max).to.equal(8);
    });
  });

  describe('pepper configuration', () => {
    const bad = [
      ['a version below 1', { secret: 's', version: 0 }],
      ['a fractional version', { secret: 's', version: 1.5 }],
      ['a previous entry without a secret', { secret: 's', version: 2, previous: [{ secret: '', version: 1 }] }],
      ['a previous entry sharing the current version', { secret: 's', version: 2, previous: [{ secret: 't', version: 2 }] }],
      ['two previous entries with one version', { secret: 's', version: 3, previous: [PEPPER_V1, { secret: 't', version: 1 }] }],
      ['a current secret that is not a string', { secret: 42, version: 1 }],
    ] as const;

    for (const [label, pepper] of bad) {
      it(`refuses ${label}`, async () => {
        const h = new Argon2PasswordHasher({ pepper: pepper as any });
        let error: unknown;
        try {
          await h.resolve();
        } catch (e) {
          error = e;
        }
        expect(error, label).to.be.instanceOf(InvalidOption);
      });
    }

    it('accepts no pepper with a previous one', async () => {
      await hasher({ pepper: { secret: null, version: 2, previous: [PEPPER_V1] } });
    });
  });

  describe('stored format helpers', () => {
    it('round-trip the pepper version', () => {
      const argon = `${ARGON2_DEFAULT_PREFIX}c2FsdA$aGFzaA`;
      expect(parseStored(formatStored(argon, 12))).to.deep.equal({ version: 12, argon2: argon });
      expect(parseStored(formatStored(argon, null))).to.deep.equal({ version: null, argon2: argon });
    });

    it('reject what is not argon2', () => {
      for (const v of ['', 'x', EXPIRED_PASSWORD_MARKER, '$sp0$$argon2id$v=19$m=1,t=1,p=1$a$b', '$sp1$garbage', '$2b$10$abc']) {
        expect(parseStored(v), v).to.equal(null);
      }
    });
  });
});

class HasherTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      authn: {
        local: {
          hasher: { service: 'Argon2PasswordHasher', maxConcurrent: 3 },
          pepper: { secret: 'di-pepper-0123456789abcdef', version: 4, previous: [PEPPER_V1] },
        },
      },
    };
  }
}

describe('Argon2PasswordHasher config wiring', function () {
  this.timeout(60_000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.unregister(HasherTestConfiguration);
    DI.register(HasherTestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  after(() => {
    DI.unregister(HasherTestConfiguration);
    DI.uncache(Configuration);
    DI.uncache(PasswordHasher);
    DI.uncache(Argon2PasswordHasher);
  });

  it('resolved through DI honours authn.local.hasher and authn.local.pepper', async () => {
    const h = await DI.resolve(PasswordHasher);
    expect(h).to.be.instanceOf(Argon2PasswordHasher);
    expect((h as Argon2PasswordHasher).limiter.max).to.equal(3);

    const stored = await h.hash(PASSWORD);
    expect(stored.startsWith(`$sp4$${ARGON2_DEFAULT_PREFIX}`), stored).to.equal(true);
    expect(await h.verify(stored, PASSWORD)).to.equal(true);

    const old = await hasher({ pepper: PEPPER_V1 });
    const oldStored = await old.hash(PASSWORD);
    expect(await h.verify(oldStored, PASSWORD)).to.equal(true);
    expect(h.needsRehash(oldStored)).to.equal(true);
  });
});
