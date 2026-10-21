import 'mocha';
import { expect } from 'chai';
import { FakeIdentityStore, MemoryPasswordCredentialStore } from '@spinajs/authn-testing';
import type { AuthnContext, Credentials } from '@spinajs/authn/contracts';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';

import { Argon2PasswordHasher } from '../src/hasher.js';
import { ConcurrencyLimiter, HasherBusy } from '../src/limiter.js';
import { AUTHN_LOCAL_CONFIGURATION_SCHEMA } from '../src/schema.js';
import { LocalPasswordStrategy } from '../src/strategy.js';
import { boot, disposeBooted, violationsOf } from './support/config-boot.js';

const LOGIN = 'alice@example.com';
const PASSWORD = 'Correct-Horse-9';
const CTX: AuthnContext = { now: new Date('2026-10-03T12:00:00Z'), purpose: 'login', ip: '203.0.113.7' };
const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Settles to the error a promise rejects with, or fails when it fulfils. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

async function withPoolSize<T>(size: string | undefined, f: () => T | Promise<T>): Promise<T> {
  const before = process.env.UV_THREADPOOL_SIZE;
  if (size === undefined) delete process.env.UV_THREADPOOL_SIZE;
  else process.env.UV_THREADPOOL_SIZE = size;
  try {
    return await f();
  } finally {
    if (before === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = before;
  }
}

describe('ConcurrencyLimiter bounded queue', () => {
  it('rejects with HasherBusy at once when max tasks run and maxQueue wait', async () => {
    const limiter = new ConcurrencyLimiter(1, 2);
    const gate = deferred();
    const started: string[] = [];
    const task = (name: string) => async () => {
      started.push(name);
      await gate.promise;
      return name;
    };

    const a = limiter.run(task('a'));
    const b = limiter.run(task('b'));
    const c = limiter.run(task('c'));
    await tick();
    expect(limiter.active).to.equal(1);
    expect(limiter.queued).to.equal(2);

    const err = await rejection(limiter.run(task('d')));
    expect(err).to.be.instanceOf(HasherBusy);
    expect(started).to.deep.equal(['a']);
    expect(limiter.queued).to.equal(2);

    gate.resolve();
    expect(await Promise.all([a, b, c])).to.deep.equal(['a', 'b', 'c']);
    expect(started).to.deep.equal(['a', 'b', 'c']);
  });

  it('takes work again once the queue has room', async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    const gate = deferred();
    const a = limiter.run(() => gate.promise);
    const b = limiter.run(async () => 'b');
    await rejection(limiter.run(async () => 'c'));

    gate.resolve();
    await Promise.all([a, b]);
    expect(await limiter.run(async () => 'd')).to.equal('d');
    expect(limiter.active).to.equal(0);
    expect(limiter.queued).to.equal(0);
  });

  it('with maxQueue 0 refuses everything while all slots are busy', async () => {
    const limiter = new ConcurrencyLimiter(2, 0);
    const gate = deferred();
    const running = [limiter.run(() => gate.promise), limiter.run(() => gate.promise)];

    expect(await rejection(limiter.run(async () => 1))).to.be.instanceOf(HasherBusy);

    gate.resolve();
    await Promise.all(running);
    expect(await limiter.run(async () => 1)).to.equal(1);
  });

  it('a refused task does not count as a run', async () => {
    const limiter = new ConcurrencyLimiter(1, 0);
    const gate = deferred();
    const a = limiter.run(() => gate.promise);
    await rejection(limiter.run(async () => 1));
    gate.resolve();
    await a;
    expect(limiter.runs).to.equal(1);
  });

  it('refuses a maxQueue that is negative or not an integer', () => {
    expect(() => new ConcurrencyLimiter(1, -1)).to.throw();
    expect(() => new ConcurrencyLimiter(1, 1.5)).to.throw();
  });
});

describe('Argon2PasswordHasher bounded queue', function () {
  this.timeout(60_000);

  it('the 4th concurrent operation of maxConcurrent 1 and maxQueue 2 rejects with HasherBusy at once', async () => {
    const hasher = new Argon2PasswordHasher({ maxConcurrent: 1, maxQueue: 2 });
    await hasher.resolve();
    const gate = deferred();

    const blocked = hasher.limiter.run(() => gate.promise);
    const first = hasher.verify(null, PASSWORD);
    const second = hasher.verify(null, PASSWORD);
    await tick();
    expect(hasher.limiter.queued).to.equal(2);

    expect(await rejection(hasher.verify(null, PASSWORD))).to.be.instanceOf(HasherBusy);
    expect(await rejection(hasher.hash(PASSWORD))).to.be.instanceOf(HasherBusy);

    gate.resolve();
    await blocked;
    expect(await Promise.all([first, second])).to.deep.equal([false, false]);
    expect(await hasher.verify(await hasher.hash(PASSWORD), PASSWORD)).to.equal(true);
  });

  it('defaults maxQueue to 64', () => {
    expect(new Argon2PasswordHasher({}).limiter.maxQueue).to.equal(64);
  });

  it('takes maxQueue from the options', () => {
    expect(new Argon2PasswordHasher({ maxQueue: 5 }).limiter.maxQueue).to.equal(5);
  });

  describe('default maxConcurrent follows the libuv thread pool', () => {
    it('is 3 with UV_THREADPOOL_SIZE unset', async () => {
      expect(await withPoolSize(undefined, () => new Argon2PasswordHasher({}).limiter.max)).to.equal(3);
    });

    it('is 7 with UV_THREADPOOL_SIZE=8', async () => {
      expect(await withPoolSize('8', () => new Argon2PasswordHasher({}).limiter.max)).to.equal(7);
    });

    it('is at least 1 with UV_THREADPOOL_SIZE=1', async () => {
      expect(await withPoolSize('1', () => new Argon2PasswordHasher({}).limiter.max)).to.equal(1);
    });

    it('ignores a UV_THREADPOOL_SIZE that is no number', async () => {
      expect(await withPoolSize('many', () => new Argon2PasswordHasher({}).limiter.max)).to.equal(3);
    });

    it('is overridden by an explicit maxConcurrent', async () => {
      expect(await withPoolSize('8', () => new Argon2PasswordHasher({ maxConcurrent: 2 }).limiter.max)).to.equal(2);
    });
  });
});

describe('LocalPasswordStrategy with a saturated hasher', function () {
  this.timeout(60_000);

  async function setup() {
    const identities = new FakeIdentityStore();
    const passwords = new MemoryPasswordCredentialStore();
    const hasher = new Argon2PasswordHasher({ maxConcurrent: 1, maxQueue: 0 });
    const strategy = new LocalPasswordStrategy({ identities, passwords, hasher });
    await strategy.resolve();
    const alice = identities.add({ login: LOGIN, email: LOGIN });
    await passwords.set(alice, await hasher.hash(PASSWORD));
    return { hasher, strategy };
  }

  it('answers throttled with retryAfterSeconds 1 for a known and an unknown login', async () => {
    const { hasher, strategy } = await setup();
    const gate = deferred();
    const blocked = hasher.limiter.run(() => gate.promise);

    expect(await strategy.verify(pw(LOGIN, PASSWORD), CTX)).to.deep.equal({ ok: false, reason: 'throttled', retryAfterSeconds: 1 });
    expect(await strategy.verify(pw('nobody@example.com', PASSWORD), CTX)).to.deep.equal({ ok: false, reason: 'throttled', retryAfterSeconds: 1 });

    gate.resolve();
    await blocked;
  });

  it('verifies again once the hasher is free', async () => {
    const { hasher, strategy } = await setup();
    const gate = deferred();
    const blocked = hasher.limiter.run(() => gate.promise);
    await strategy.verify(pw(LOGIN, PASSWORD), CTX);
    gate.resolve();
    await blocked;

    const outcome = await strategy.verify(pw(LOGIN, PASSWORD), CTX);
    expect(outcome.ok).to.equal(true);
  });
});

describe('authn.local.hasher schema', function () {
  this.timeout(30_000);
  afterEach(disposeBooted);

  const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_LOCAL_CONFIGURATION_SCHEMA];

  it('still refuses every argon2 cost key (H30)', async () => {
    for (const key of ['memoryCost', 'timeCost', 'parallelism', 'hashLength', 'saltLength', 'type', 'cost']) {
      expect(await violationsOf(SCHEMAS, { authn: { local: { hasher: { [key]: 1 } } } }), key).to.include(`authn.local.hasher.${key}`);
    }
  });

  it('fills maxQueue with 64 and keeps a configured one', async () => {
    expect((await boot(SCHEMAS, { authn: { local: {} } })).configuration.get('authn.local.hasher.maxQueue')).to.equal(64);
    await disposeBooted();
    expect((await boot(SCHEMAS, { authn: { local: { hasher: { maxQueue: 0 } } } })).configuration.get('authn.local.hasher.maxQueue')).to.equal(0);
  });

  it('leaves maxConcurrent unset so the default follows the thread pool', async () => {
    expect((await boot(SCHEMAS, { authn: { local: {} } })).configuration.get('authn.local.hasher.maxConcurrent')).to.equal(undefined);
  });
});
