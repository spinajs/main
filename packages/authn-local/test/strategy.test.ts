import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthenticationStrategy, IdentityStore, PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome } from '@spinajs/authn/contracts';
import { FakeIdentityStore, MemoryPasswordCredentialStore } from '@spinajs/authn-testing';

import { Argon2PasswordHasher, Argon2PasswordHasherOptions, EXPIRED_PASSWORD_MARKER, PasswordHasher } from '../src/hasher.js';
import { LocalPasswordStrategy, LocalPasswordStrategyLog } from '../src/strategy.js';

const ARGON2_DEFAULT_PREFIX = '$argon2id$v=19$m=65536,t=3,p=4$';
const LOGIN = 'alice@example.com';
const PASSWORD = 'Correct-Horse-9';
const PEPPER = { secret: 'strategy-pepper-0123456789', version: 3 };
const CTX: AuthnContext = { now: new Date('2026-10-03T12:00:00Z'), purpose: 'login', ip: '203.0.113.7' };
const INVALID: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };

const pw = (login: unknown, password: unknown): Credentials => ({ kind: 'password', login, password }) as Credentials;

class RecordingLog implements LocalPasswordStrategyLog {
  public readonly lines: string[] = [];
  public warn(message: string, ...args: unknown[]): void {
    this.lines.push([message, ...args.map((a) => (a instanceof Error ? a.message : String(a)))].join(' '));
  }
}

class StoreDownError extends Error {
  public name = 'StoreDownError';
}

class FailingPasswordStore extends MemoryPasswordCredentialStore {
  public failSet = false;
  public readonly gets: IdentityRef[] = [];
  public async get(id: IdentityRef): Promise<string | null> {
    this.gets.push(id);
    return super.get(id);
  }
  public async set(id: IdentityRef, hash: string): Promise<void> {
    if (this.failSet) {
      // Some ORM paths put the query bindings, i.e. the new hash, into the message.
      throw new StoreDownError(`insert failed with bindings [${hash}]`);
    }
    return super.set(id, hash);
  }
}

async function setup(hasherOptions: Argon2PasswordHasherOptions = {}) {
  const identities = new FakeIdentityStore();
  const passwords = new FailingPasswordStore();
  const hasher = new Argon2PasswordHasher(hasherOptions);
  const log = new RecordingLog();
  const strategy = new LocalPasswordStrategy({ identities, passwords, hasher, log });
  const runsBeforeResolve = hasher.limiter.runs;
  await strategy.resolve();
  const dummyRuns = hasher.limiter.runs - runsBeforeResolve;
  const alice = identities.add({ login: LOGIN, email: LOGIN });
  await passwords.set(alice, await hasher.hash(PASSWORD));
  passwords.writes.length = 0;
  passwords.gets.length = 0;
  return { identities, passwords, hasher, log, strategy, alice, dummyRuns };
}

async function runs(hasher: Argon2PasswordHasher, f: () => Promise<unknown>): Promise<number> {
  const before = hasher.limiter.runs;
  await f();
  return hasher.limiter.runs - before;
}

async function elapsedMs(f: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await f();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const median3 = (xs: number[]) => [...xs].sort((a, b) => a - b)[1];

describe('LocalPasswordStrategy', function () {
  this.timeout(60_000);

  it('is the interactive local password strategy', async () => {
    const { strategy } = await setup();
    expect(strategy).to.be.instanceOf(AuthenticationStrategy);
    expect(strategy.name).to.equal('local');
    expect(strategy.kinds).to.deep.equal(['password']);
    expect(strategy.interactive).to.equal(true);
  });

  describe('verify', () => {
    it('the right password gives the identity', async () => {
      const { strategy, alice } = await setup();
      expect(await strategy.verify(pw(LOGIN, PASSWORD), CTX)).to.deep.equal({ ok: true, identity: alice, method: 'password' });
    });

    it('passes the login to findByLogin as given', async () => {
      const { strategy, identities, alice } = await setup();
      const res = await strategy.verify(pw(' Alice@Example.com', PASSWORD), CTX);
      expect(identities.calls.findByLogin).to.deep.equal([' Alice@Example.com']);
      expect(res).to.deep.equal(INVALID);
      expect(await strategy.verify(pw('ALICE@example.com', PASSWORD), CTX)).to.deep.equal({ ok: true, identity: alice, method: 'password' });
    });

    it('a wrong password fails', async () => {
      const { strategy } = await setup();
      expect(await strategy.verify(pw(LOGIN, 'Wrong-Horse-9'), CTX)).to.deep.equal(INVALID);
    });

    it('an unknown login fails', async () => {
      const { strategy } = await setup();
      expect(await strategy.verify(pw('bob@example.com', PASSWORD), CTX)).to.deep.equal(INVALID);
    });

    it('a stored null or the expired marker fails', async () => {
      const { strategy, identities, passwords, alice } = await setup();
      await passwords.set(alice, EXPIRED_PASSWORD_MARKER);
      expect(await strategy.verify(pw(LOGIN, PASSWORD), CTX)).to.deep.equal(INVALID);
      expect(await strategy.verify(pw(LOGIN, EXPIRED_PASSWORD_MARKER), CTX)).to.deep.equal(INVALID);

      identities.add({ login: 'nopass@example.com' });
      expect(await strategy.verify(pw('nopass@example.com', PASSWORD), CTX)).to.deep.equal(INVALID);
    });

    it('login lengths 7 and 129 fail even when that exact password is stored', async () => {
      const { strategy, passwords, hasher, alice } = await setup();
      for (const password of ['a'.repeat(7), 'a'.repeat(129)]) {
        await passwords.set(alice, await hasher.hash(password));
        expect(await strategy.verify(pw(LOGIN, password), CTX), `length ${password.length}`).to.deep.equal(INVALID);
      }
      await passwords.set(alice, await hasher.hash('a'.repeat(128)));
      expect((await strategy.verify(pw(LOGIN, 'a'.repeat(128)), CTX)).ok).to.equal(true);
    });

    it('never trims the password', async () => {
      const { strategy, passwords, hasher, alice } = await setup();
      await passwords.set(alice, await hasher.hash('  Spaced-Out-9  '));
      expect((await strategy.verify(pw(LOGIN, '  Spaced-Out-9  '), CTX)).ok).to.equal(true);
      expect(await strategy.verify(pw(LOGIN, 'Spaced-Out-9'), CTX)).to.deep.equal(INVALID);
    });

    it('a non-password credential fails without throwing', async () => {
      const { strategy } = await setup();
      expect(await strategy.verify({ kind: 'bearer', token: 'spt_x' }, CTX)).to.deep.equal(INVALID);
    });

    it('a password credential with non-string fields fails without throwing', async () => {
      const { strategy } = await setup();
      for (const c of [pw(42, PASSWORD), pw(LOGIN, 42), pw(undefined, undefined), pw({ toString: () => LOGIN }, PASSWORD), pw(LOGIN, [PASSWORD])]) {
        expect(await strategy.verify(c, CTX)).to.deep.equal(INVALID);
      }
      expect(await strategy.verify(null as unknown as Credentials, CTX)).to.deep.equal(INVALID);
    });
  });

  describe('rehash (A03)', () => {
    it('a hash under other argon2 parameters is replaced after a successful login', async () => {
      const { strategy, passwords, hasher, alice } = await setup();
      const old = await hasher.hashWith(PASSWORD, { argon2: { memoryCost: 4096, timeCost: 2, parallelism: 1 }, pepper: null });
      await passwords.set(alice, old);

      expect((await strategy.verify(pw(LOGIN, PASSWORD), CTX)).ok).to.equal(true);
      const stored = await passwords.get(alice);
      expect(stored).to.not.equal(old);
      expect(stored!.startsWith(ARGON2_DEFAULT_PREFIX), stored!).to.equal(true);
      expect(await hasher.verify(stored, PASSWORD)).to.equal(true);
    });

    it('a failed login does not rewrite it', async () => {
      const { strategy, passwords, hasher, alice } = await setup();
      const old = await hasher.hashWith(PASSWORD, { argon2: { memoryCost: 4096, timeCost: 2, parallelism: 1 }, pepper: null });
      await passwords.set(alice, old);
      passwords.writes.length = 0;

      expect(await strategy.verify(pw(LOGIN, 'Wrong-Horse-9'), CTX)).to.deep.equal(INVALID);
      expect(await passwords.get(alice)).to.equal(old);
      expect(passwords.writes).to.have.length(0);
    });

    it('a current hash is not rewritten', async () => {
      const { strategy, passwords } = await setup();
      expect((await strategy.verify(pw(LOGIN, PASSWORD), CTX)).ok).to.equal(true);
      expect(passwords.writes).to.have.length(0);
    });

    it('an unpeppered hash is rewritten under the current pepper', async () => {
      const { strategy, passwords, hasher, alice } = await setup({ pepper: PEPPER });
      await passwords.set(alice, await hasher.hashWith(PASSWORD, { pepper: null }));

      expect((await strategy.verify(pw(LOGIN, PASSWORD), CTX)).ok).to.equal(true);
      const stored = await passwords.get(alice);
      expect(stored!.startsWith(`$sp3$${ARGON2_DEFAULT_PREFIX}`), stored!).to.equal(true);
    });

    it('a failure to store the rehash does not fail the login and logs no secret', async () => {
      const { strategy, passwords, hasher, log, alice } = await setup();
      const old = await hasher.hashWith(PASSWORD, { argon2: { memoryCost: 4096, timeCost: 2, parallelism: 1 }, pepper: null });
      await passwords.set(alice, old);
      passwords.failSet = true;

      expect(await strategy.verify(pw(LOGIN, PASSWORD), CTX)).to.deep.equal({ ok: true, identity: alice, method: 'password' });
      expect(await passwords.get(alice)).to.equal(old);
      expect(log.lines).to.have.length(1);
      const line = log.lines[0];
      expect(line).to.contain('StoreDownError');
      expect(line).to.not.contain('bindings');
      expect(line).to.not.contain(PASSWORD);
      expect(line).to.not.contain('$argon2');
      expect(line).to.not.contain(LOGIN);
    });
  });

  describe('throttle keys (D7)', () => {
    it('account is the normalised login, account-ip adds ctx.ip', async () => {
      const { strategy } = await setup();
      expect(strategy.throttleKeys(pw('  Alice@Example.COM ', PASSWORD), CTX)).to.deep.equal([
        { kind: 'account', value: 'alice@example.com' },
        { kind: 'account-ip', value: 'alice@example.com|203.0.113.7' },
      ]);
    });

    it('NFKC-normalises the login', async () => {
      const { strategy } = await setup();
      const [account] = strategy.throttleKeys(pw('Ａlice', PASSWORD), CTX);
      expect(account).to.deep.equal({ kind: 'account', value: 'alice' });
    });

    it('without an ip the account-ip key ends with an empty ip', async () => {
      const { strategy } = await setup();
      const { ip: _ip, ...noIp } = CTX;
      expect(strategy.throttleKeys(pw(LOGIN, PASSWORD), noIp)).to.deep.equal([
        { kind: 'account', value: LOGIN },
        { kind: 'account-ip', value: `${LOGIN}|` },
      ]);
    });

    it('no key contains the password', async () => {
      const { strategy } = await setup();
      const keys = strategy.throttleKeys(pw(LOGIN, 'Secret-Value-77'), CTX);
      expect(keys.some((k) => k.value.includes('Secret-Value-77'))).to.equal(false);
    });

    it('a non-password or malformed credential gives no keys and does not throw', async () => {
      const { strategy } = await setup();
      expect(strategy.throttleKeys({ kind: 'bearer', token: 'spt_x' }, CTX)).to.deep.equal([]);
      expect(strategy.throttleKeys(pw(42, PASSWORD), CTX)).to.deep.equal([]);
      expect(strategy.throttleKeys(null as unknown as Credentials, CTX)).to.deep.equal([]);
    });
  });

  describe('cost (A02)', () => {
    it('SR-04 unknown login costs a hash', async () => {
      const { strategy, hasher } = await setup();
      expect(await runs(hasher, () => strategy.verify(pw('bob@example.com', PASSWORD), CTX))).to.equal(1);
    });

    it('an unknown login still reads the credential store once, for a ref that matches no identity', async () => {
      const { strategy, passwords, identities, alice } = await setup();
      await strategy.verify(pw('bob@example.com', PASSWORD), CTX);
      await strategy.verify(pw('carol@example.com', PASSWORD), CTX);
      expect(passwords.gets).to.have.length(2);
      const [first, second] = passwords.gets;
      expect(first.type).to.equal('user');
      expect(first.id).to.not.equal(alice.id);
      expect(first.id).to.not.equal(second.id);
      expect((await identities.status(first)).exists).to.equal(false);
    });

    it('a known login reads the credential store once', async () => {
      const { strategy, passwords, alice } = await setup();
      await strategy.verify(pw(LOGIN, 'Wrong-Horse-9'), CTX);
      expect(passwords.gets).to.deep.equal([alice]);
    });

    it('the dummy hash is made at resolve, before any verify (D4)', async () => {
      const { dummyRuns } = await setup();
      expect(dummyRuns).to.be.at.least(1);
    });

    it('every failing path costs exactly one argon2 verify; success adds a rehash only when needed', async () => {
      const { strategy, hasher, passwords, identities, alice } = await setup();
      identities.add({ login: 'nopass@example.com' });
      const cases: [string, Credentials, number][] = [
        ['wrong password', pw(LOGIN, 'Wrong-Horse-9'), 1],
        ['unknown login', pw('bob@example.com', PASSWORD), 1],
        ['no stored password', pw('nopass@example.com', PASSWORD), 1],
        ['too short', pw(LOGIN, 'short'), 1],
        ['too long', pw(LOGIN, 'x'.repeat(129)), 1],
        ['non-string fields', pw(42, 42), 1],
        ['other kind', { kind: 'bearer', token: 'spt_x' }, 1],
        ['right password', pw(LOGIN, PASSWORD), 1],
      ];
      for (const [label, c, expected] of cases) {
        expect(await runs(hasher, () => strategy.verify(c, CTX)), label).to.equal(expected);
      }

      await passwords.set(alice, EXPIRED_PASSWORD_MARKER);
      expect(await runs(hasher, () => strategy.verify(pw(LOGIN, PASSWORD), CTX)), 'expired').to.equal(1);

      await passwords.set(alice, await hasher.hashWith(PASSWORD, { argon2: { memoryCost: 4096, timeCost: 2, parallelism: 1 }, pepper: null }));
      expect(await runs(hasher, () => strategy.verify(pw(LOGIN, PASSWORD), CTX)), 'rehash').to.equal(2);
    });

    it('an unknown login takes about as long as a wrong password', async () => {
      const { strategy } = await setup();
      const unknown: number[] = [];
      const wrong: number[] = [];
      for (let i = 0; i < 3; i++) {
        unknown.push(await elapsedMs(() => strategy.verify(pw('bob@example.com', 'Wrong-Horse-9'), CTX)));
        wrong.push(await elapsedMs(() => strategy.verify(pw(LOGIN, 'Wrong-Horse-9'), CTX)));
      }
      const ratio = median3(unknown) / median3(wrong);
      expect(ratio, `unknown ${unknown} wrong ${wrong}`).to.be.within(0.5, 2);
    });
  });
});

class StrategyTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      authn: { local: { hasher: { maxConcurrent: 2 }, pepper: PEPPER } },
    };
  }
}

describe('LocalPasswordStrategy DI wiring', function () {
  this.timeout(60_000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(StrategyTestConfiguration).as(Configuration);
    DI.register(FakeIdentityStore).as(IdentityStore);
    DI.register(MemoryPasswordCredentialStore).as(PasswordCredentialStore);
    await DI.resolve(Configuration);
  });

  after(() => {
    DI.unregister(StrategyTestConfiguration);
    DI.unregister(FakeIdentityStore);
    DI.unregister(MemoryPasswordCredentialStore);
    DI.uncache(Configuration);
    DI.uncache(IdentityStore);
    DI.uncache(PasswordCredentialStore);
    DI.uncache(PasswordHasher);
    DI.uncache(Argon2PasswordHasher);
    DI.uncache(LocalPasswordStrategy);
  });

  it('resolves the hasher at boot and the stores lazily from the container', async () => {
    const strategy = await DI.resolve(LocalPasswordStrategy);
    const hasher = (await DI.resolve(PasswordHasher)) as Argon2PasswordHasher;
    expect(hasher.limiter.max).to.equal(2);
    expect(hasher.limiter.runs, 'dummy hash made at boot (D4)').to.be.at.least(1);

    const identities = DI.resolve(IdentityStore) as FakeIdentityStore;
    const passwords = DI.resolve(PasswordCredentialStore) as MemoryPasswordCredentialStore;
    const alice = identities.add({ login: LOGIN });
    await passwords.set(alice, await hasher.hashWith(PASSWORD, { pepper: null }));

    expect(await strategy.verify(pw(LOGIN, PASSWORD), CTX)).to.deep.equal({ ok: true, identity: alice, method: 'password' });
    expect((await passwords.get(alice))!.startsWith('$sp3$')).to.equal(true);
  });
});
