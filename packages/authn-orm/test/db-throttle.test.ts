import { DEFAULT_THROTTLE, FakeClock, pwKeys } from '@spinajs/authn-testing';
import type { AuthnContext, ThrottleKey } from '@spinajs/authn/contracts';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { OrmDriver, QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { createHmac } from 'node:crypto';

import { DbAuthnThrottle, ThrottleParams } from '../src/index.js';
import type { ClaimState, Claimed, StoreTimes } from '../src/throttle/db-throttle.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const IP = '192.0.2.10';
const OTHER_IP = '192.0.2.20';
const T0 = new Date('2026-06-01T10:00:00.000Z');
const HASH_KEY = 'n4-throttle-test-hash-key-0123456789abcdef';

const ctxAt = (now: Date): AuthnContext => ({ now, ip: IP, userAgent: 'authn-orm-test', purpose: 'login' });

interface Row {
  k: string;
  attempts: number;
  last_text: string;
  next_text: string;
}

async function rows(db: TestDb): Promise<Row[]> {
  const out = (await rawQuery(db.driver, 'SELECT k, attempts, CAST(last_attempt_at AS TEXT) AS last_text, CAST(next_allowed_at AS TEXT) AS next_text FROM authn_throttle ORDER BY k')) as Row[];
  return out.map((r) => ({ ...r, attempts: Number(r.attempts) }));
}

async function row(db: TestDb, k: string): Promise<Row | undefined> {
  return (await rows(db)).find((r) => r.k === k);
}

async function plant(db: TestDb, k: string, attempts: number, last: string, next: string): Promise<void> {
  await rawQuery(db.driver, 'INSERT INTO authn_throttle (k, attempts, last_attempt_at, next_allowed_at, updated_at) VALUES (?, ?, ?, ?, ?)', [k, attempts, last, next, last], QueryContext.Insert);
}

/** Runs `between` once, right after the first gating key of the next attempt was claimed. */
class InterleavingThrottle extends DbAuthnThrottle {
  public between: (() => Promise<void>) | undefined;

  protected override async claimKey(db: OrmDriver, k: string, delay: (n: number) => number, state: ClaimState | undefined, t: StoreTimes, rest?: readonly string[]): Promise<Claimed> {
    const r = await super.claimKey(db, k, delay, state, t, rest);
    const between = this.between;
    if (between && r.ok) {
      this.between = undefined;
      await between();
    }
    return r;
  }
}

/** Every write misses, as if other attempts always won the race. */
class AlwaysMissThrottle extends DbAuthnThrottle {
  public writes = 0;

  protected override async writeLive(): Promise<boolean> {
    this.writes++;
    return false;
  }

  protected override async insertOrTakeStale(): Promise<boolean> {
    this.writes++;
    return false;
  }
}

describe('DbAuthnThrottle arguments', () => {
  const throttle = new DbAuthnThrottle({} as OrmDriver, DEFAULT_THROTTLE);

  it('throws InvalidArgument when ctx.now is not a valid Date', async () => {
    for (const now of [new Date(NaN), '2026-06-01T10:00:00Z', undefined]) {
      let err: unknown;
      try {
        await throttle.attempt(pwKeys('a@example.test', IP), 'login', { ...ctxAt(T0), now } as unknown as AuthnContext);
      } catch (e) {
        err = e;
      }
      expect(err, String(now)).to.be.instanceOf(InvalidArgument);
    }
  });

  it('throws InvalidArgument when a key value is not a string', async () => {
    const keys = [{ kind: 'account', value: 42 }] as unknown as ThrottleKey[];
    let err: unknown;
    try {
      await throttle.attempt(keys, 'login', ctxAt(T0));
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(InvalidArgument);
    err = undefined;
    try {
      await throttle.succeed(keys, 'login');
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(InvalidArgument);
  });

  it('throws InvalidOption on explicit params with an unknown key', () => {
    expect(() => new DbAuthnThrottle({} as OrmDriver, { ...DEFAULT_THROTTLE, maxRow: 1 } as unknown as ThrottleParams)).to.throw(InvalidOption);
  });

  it('keeps k stable for the same input and apart per flow, kind and hash key', () => {
    const key: ThrottleKey = { kind: 'account', value: 'alice@example.test' };
    const keyed = new DbAuthnThrottle({} as OrmDriver, DEFAULT_THROTTLE, { hashKey: 'a-configured-audit-hash-key-0123456789' });
    expect(throttle.rowKey('login', key)).to.eq(throttle.rowKey('login', { ...key }));
    expect(throttle.rowKey('login', key)).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(throttle.rowKey('login', key)).to.not.eq(throttle.rowKey('mfa', key));
    expect(throttle.rowKey('login', key)).to.not.eq(throttle.rowKey('login', { kind: 'ip', value: key.value }));
    expect(keyed.rowKey('login', key)).to.not.eq(throttle.rowKey('login', key));
  });
});

for (const kind of DB_KINDS) {
  describe(`DbAuthnThrottle store (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let clock: FakeClock;

    before(async function () {
      db = await bootDb(this, kind, 'throttle_store', { config: { authn: { throttle: { login: { account: { free: 2 } } }, audit: { hashKey: { secret: HASH_KEY } } } } });
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authn_throttle', [], QueryContext.Delete);
      clock = new FakeClock(T0);
      clock.install();
    });

    afterEach(() => {
      clock.uninstall();
    });

    it('SR-19: stores no raw login or IP, only keyed hashes', async () => {
      const login = 'secret-login@example.test';
      const ip = '203.0.113.7';
      const throttle = new DbAuthnThrottle(db.driver, DEFAULT_THROTTLE);
      expect(await throttle.attempt(pwKeys(login, ip), 'login', ctxAt(T0))).to.deep.eq({ allowed: true });

      const all = await rows(db);
      expect(all.map((r) => r.k).sort()).to.deep.eq(
        pwKeys(login, ip)
          .map((key) => throttle.rowKey('login', key))
          .sort(),
      );
      for (const r of all) {
        expect(r.k).to.match(/^[A-Za-z0-9_-]{43}$/);
        for (const part of [login, ip, 'secret-login', '203.0.113']) {
          expect(r.k).to.not.contain(part);
        }
      }
    });

    it('resolves the Orm and authn.throttle from its container when given no driver', async () => {
      const throttle = new DbAuthnThrottle(undefined, undefined, { container: db.container });
      const keys: ThrottleKey[] = [{ kind: 'account', value: 'from-config@example.test' }];
      await throttle.init();
      expect(throttle.params.login.account?.free).to.eq(2);
      expect(await throttle.attempt(keys, 'login', ctxAt(T0))).to.deep.eq({ allowed: true });
      expect(await throttle.attempt(keys, 'login', ctxAt(T0))).to.deep.eq({ allowed: true });
      expect(await throttle.attempt(keys, 'login', ctxAt(T0))).to.deep.eq({ allowed: false, retryAfterSeconds: 1 });
    });

    it('keys rows with authn.audit.hashKey.secret from the configuration', async () => {
      const key: ThrottleKey = { kind: 'account', value: 'keyed@example.test' };
      const fromConfig = new DbAuthnThrottle(undefined, undefined, { container: db.container });
      await fromConfig.init();
      const expected = createHmac('sha256', HASH_KEY).update('login|account|keyed@example.test', 'utf8').digest('base64url');
      expect(fromConfig.rowKey('login', key)).to.eq(expected);
      expect(fromConfig.rowKey('login', key)).to.eq(new DbAuthnThrottle(db.driver, DEFAULT_THROTTLE, { hashKey: HASH_KEY }).rowKey('login', key));
      expect(fromConfig.rowKey('login', key)).to.not.eq(new DbAuthnThrottle(db.driver, DEFAULT_THROTTLE).rowKey('login', key));

      expect(await fromConfig.attempt([key], 'login', ctxAt(T0))).to.deep.eq({ allowed: true });
      expect((await rows(db)).map((r) => r.k)).to.deep.eq([expected]);
    });

    it('peek refuses while a delay holds and writes nothing (K5)', async () => {
      const params: ThrottleParams = { ...DEFAULT_THROTTLE, login: { account: { free: 1, baseDelayMs: 2000, maxDelayMs: 2000 } } };
      const throttle = new DbAuthnThrottle(db.driver, params);
      const keys = pwKeys('peek@example.test', IP);
      expect(await throttle.peek(keys, 'login', ctxAt(T0))).to.deep.eq({ allowed: true });
      expect(await rows(db)).to.deep.eq([]);
      expect(await throttle.attempt(keys, 'login', ctxAt(T0))).to.deep.eq({ allowed: true });
      const before = await rows(db);
      expect(await throttle.peek(keys, 'login', ctxAt(T0))).to.deep.eq({ allowed: false, retryAfterSeconds: 2 });
      expect(await throttle.peek(keys, 'mfa', ctxAt(T0))).to.deep.eq({ allowed: true });
      expect(await rows(db)).to.deep.eq(before);
      const later = new Date(T0.getTime() + 2000);
      expect(await throttle.peek(keys, 'login', ctxAt(later))).to.deep.eq({ allowed: true });
      expect(await throttle.attempt(keys, 'login', ctxAt(later))).to.deep.eq({ allowed: true });
    });

    it('lets one of 20 parallel attempts take over a stale row', async () => {
      const params: ThrottleParams = { ...DEFAULT_THROTTLE, login: { account: { free: 1, baseDelayMs: 1000, maxDelayMs: 1000 } } };
      const throttle = new DbAuthnThrottle(db.driver, params);
      const key: ThrottleKey = { kind: 'account', value: 'stale-race@example.test' };
      const k = throttle.rowKey('login', key);
      await plant(db, k, 7, '2026-05-30 09:00:00.000', '2026-05-30 09:00:30.000');

      const results = await Promise.all(Array.from({ length: 20 }, () => throttle.attempt([key], 'login', ctxAt(T0))));

      expect(results.filter((r) => r.allowed)).to.have.length(1);
      for (const r of results.filter((x) => !x.allowed)) {
        expect(r).to.deep.eq({ allowed: false, retryAfterSeconds: 1 });
      }
      expect((await row(db, k))?.attempts).to.eq(1);
    });

    it('undoes the first claim when the second gating key refuses', async () => {
      const throttle = new InterleavingThrottle(db.driver, DEFAULT_THROTTLE);
      const keys: ThrottleKey[] = [
        { kind: 'account', value: 'undo@example.test' },
        { kind: 'ip', value: IP },
      ];
      for (let i = 0; i < 2; i++) {
        expect(await throttle.attempt(keys, 'login', ctxAt(T0))).to.deep.eq({ allowed: true });
      }
      const [first, second] = keys.map((key) => throttle.rowKey('login', key)).sort();
      const before = await row(db, first);
      expect(before?.attempts).to.eq(2);

      // 90 s after the attempt below: the second key now delays it.
      throttle.between = () => rawQuery(db.driver, 'UPDATE authn_throttle SET next_allowed_at = ? WHERE k = ?', ['2026-06-01 10:01:31.000', second], QueryContext.Update);
      const later = new Date(T0.getTime() + 1000);
      expect(await throttle.attempt(keys, 'login', ctxAt(later))).to.deep.eq({ allowed: false, retryAfterSeconds: 90 });
      expect(throttle.between).to.eq(undefined);

      const after = await row(db, first);
      expect(after).to.deep.eq(before);
    });

    it('deletes a row it inserted when a later key refuses', async () => {
      const throttle = new InterleavingThrottle(db.driver, DEFAULT_THROTTLE);
      const keys: ThrottleKey[] = [
        { kind: 'account', value: 'undo-insert@example.test' },
        { kind: 'ip', value: OTHER_IP },
      ];
      const [first, second] = keys.map((key) => throttle.rowKey('login', key)).sort();
      throttle.between = () => plant(db, second, 30, '2026-06-01 10:00:00.000', '2026-06-01 10:00:05.000');
      expect(await throttle.attempt(keys, 'login', ctxAt(T0))).to.deep.eq({ allowed: false, retryAfterSeconds: 5 });
      expect(await row(db, first)).to.eq(undefined);
      expect((await row(db, second))?.attempts).to.eq(30);
    });

    it('fails closed when every write misses, after a bounded number of tries', async () => {
      const throttle = new AlwaysMissThrottle(db.driver, DEFAULT_THROTTLE);
      expect(await throttle.attempt(pwKeys('miss@example.test', IP), 'login', ctxAt(T0))).to.deep.eq({ allowed: false, retryAfterSeconds: 1 });
      expect(throttle.writes).to.be.greaterThan(1).and.lessThan(1000);
      expect(await rows(db)).to.deep.eq([]);
    });

    it('subtracts the account-ip count from the ip key once when succeed runs twice in parallel', async () => {
      const throttle = new DbAuthnThrottle(db.driver, DEFAULT_THROTTLE);
      const alice = pwKeys('alice@example.test', IP);
      const bob = pwKeys('bob@example.test', IP);
      for (let i = 0; i < 3; i++) await throttle.attempt(bob, 'login', ctxAt(T0));
      for (let i = 0; i < 2; i++) await throttle.attempt(alice, 'login', ctxAt(T0));
      const ipK = throttle.rowKey('login', { kind: 'ip', value: IP });
      expect((await row(db, ipK))?.attempts).to.eq(5);

      await Promise.all([throttle.succeed(alice, 'login'), throttle.succeed(alice, 'login')]);

      expect((await row(db, ipK))?.attempts).to.eq(3);
      expect(await row(db, throttle.rowKey('login', alice[0]))).to.eq(undefined);
      expect(await row(db, throttle.rowKey('login', alice[1]))).to.eq(undefined);
      expect((await row(db, throttle.rowKey('login', bob[0])))?.attempts).to.eq(3);
    });

    it('succeed keeps the ip schedule running from its last attempt', async () => {
      const params: ThrottleParams = { ...DEFAULT_THROTTLE, login: { account: DEFAULT_THROTTLE.login.account, ip: { free: 1, baseDelayMs: 4000, maxDelayMs: 60000 } } };
      const throttle = new DbAuthnThrottle(db.driver, params);
      const ipK = throttle.rowKey('login', { kind: 'ip', value: IP });
      await throttle.attempt(pwKeys('carol@example.test', IP), 'login', ctxAt(T0));
      clock.set(new Date(T0.getTime() + 8000));
      await throttle.attempt(pwKeys('dave@example.test', IP), 'login', ctxAt(clock.now()));
      expect((await row(db, ipK))?.attempts).to.eq(2);

      await throttle.succeed(pwKeys('dave@example.test', IP), 'login');

      const r = await row(db, ipK);
      expect(r?.attempts).to.eq(1);
      // attempt 1 after free 1 waits 4 s from the last attempt (T0 + 8 s)
      expect(new Date(r!.next_text.replace(' ', 'T') + 'Z').getTime()).to.eq(T0.getTime() + 12000);
    });

    it('purge throws InvalidArgument on an invalid date', async () => {
      const throttle = new DbAuthnThrottle(db.driver, DEFAULT_THROTTLE);
      let err: unknown;
      try {
        await throttle.purge(new Date(NaN));
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(InvalidArgument);
    });

    it('purges stale rows only', async () => {
      const throttle = new DbAuthnThrottle(db.driver, DEFAULT_THROTTLE);
      const now = new Date('2026-06-03T10:00:00.000Z');
      await plant(db, 'stale', 3, '2026-06-01 09:00:00.000', '2026-06-01 09:00:01.000');
      await plant(db, 'live', 3, '2026-06-02 11:00:00.000', '2026-06-02 11:00:01.000');
      await plant(db, 'idle-but-delaying', 30, '2026-06-01 09:00:00.000', '2026-06-04 09:00:00.000');
      await plant(db, 'blocked', 9, '2026-06-03 09:59:59.000', '2026-06-03 10:05:00.000');

      expect(await throttle.purge(now)).to.eq(1);

      expect((await rows(db)).map((r) => r.k).sort()).to.deep.eq(['blocked', 'idle-but-delaying', 'live']);
    });
  });
}
