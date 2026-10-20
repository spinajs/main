import { DEFAULT_THROTTLE, pwKeys } from '@spinajs/authn-testing';
import type { AuthnContext } from '@spinajs/authn/contracts';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { DbAuthnThrottle } from '../../src/index.js';
import type { ThrottleParams } from '../../src/index.js';
import { TestDb, bootDb, rawQuery } from '../support/db.js';

const IP = '192.0.2.10';
const T0 = new Date('2026-06-01T10:00:00.000Z');
const ctxAt = (now: Date): AuthnContext => ({ now, ip: IP, userAgent: 'authn-orm-test', purpose: 'request' });

describe('DbAuthnThrottle peek reports a clean key set (sqlite)', function () {
  this.timeout(60000);

  let db: TestDb;
  let statements: string[];

  before(async function () {
    db = await bootDb(this, 'sqlite', 'peek_clean');
    const driver = db.driver as unknown as { executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown> };
    const original = driver.executeOnDb.bind(driver);
    driver.executeOnDb = (stmt, params, context) => {
      statements.push(stmt);
      return original(stmt, params, context);
    };
  });

  after(async () => {
    await db?.dispose();
  });

  beforeEach(async () => {
    statements = [];
    await rawQuery(db.driver, 'DELETE FROM authn_throttle', [], QueryContext.Delete);
  });

  /** The statements one peek runs, after a warm-up peek on other keys has built the store. */
  async function peekCounted(throttle: DbAuthnThrottle, login: string, at = T0) {
    await throttle.peek(pwKeys('warm-up@example.test', '198.51.100.1'), 'login', ctxAt(at));
    statements = [];
    const verdict = await throttle.peek(pwKeys(login, IP), 'login', ctxAt(at));
    return { verdict, statements: [...statements] };
  }

  it('answers { allowed: true, clean: true } for keys with no rows, in one SELECT', async () => {
    const { verdict, statements: run } = await peekCounted(new DbAuthnThrottle(DEFAULT_THROTTLE), 'nobody@example.test');
    expect(verdict).to.deep.eq({ allowed: true, clean: true });
    expect(run).to.have.length(1);
    expect(run[0]).to.match(/^\s*select\b/i);
  });

  it('answers { allowed: true, clean: false } when a live row that delays nobody holds a key, in one SELECT', async () => {
    const throttle = new DbAuthnThrottle(DEFAULT_THROTTLE);
    expect(await throttle.attempt(pwKeys('once@example.test', IP), 'login', ctxAt(T0))).to.deep.eq({ allowed: true });
    const { verdict, statements: run } = await peekCounted(throttle, 'once@example.test');
    expect(verdict).to.deep.eq({ allowed: true, clean: false });
    expect(run).to.have.length(1);
  });

  it('refuses with retryAfterSeconds while a row delays', async () => {
    const params: ThrottleParams = { ...DEFAULT_THROTTLE, login: { account: { free: 1, baseDelayMs: 2000, maxDelayMs: 2000 } } };
    const throttle = new DbAuthnThrottle(params);
    expect(await throttle.attempt(pwKeys('blocked@example.test', IP), 'login', ctxAt(T0))).to.deep.eq({ allowed: true });
    const { verdict, statements: run } = await peekCounted(throttle, 'blocked@example.test');
    expect(verdict).to.deep.eq({ allowed: false, retryAfterSeconds: 2 });
    expect(run).to.have.length(1);
  });

  it('counts a stale row as clean', async () => {
    const throttle = new DbAuthnThrottle(DEFAULT_THROTTLE);
    expect(await throttle.attempt(pwKeys('stale@example.test', IP), 'login', ctxAt(T0))).to.deep.eq({ allowed: true });
    const later = new Date(T0.getTime() + (DEFAULT_THROTTLE.resetAfterSeconds + 1) * 1000);
    const { verdict } = await peekCounted(throttle, 'stale@example.test', later);
    expect(verdict).to.deep.eq({ allowed: true, clean: true });
  });
});
