import { InvalidOption } from '@spinajs/exceptions';
import { DEFAULT_THROTTLE } from '@spinajs/authn-testing';
import { expect } from 'chai';
import 'mocha';

import { DEFAULT_THROTTLE_PARAMS, backoffDelayMs, checkThrottleParams, readThrottleConfig } from '../src/index.js';

describe('throttle params (authn.throttle)', () => {
  it('defaults to design §22.5', () => {
    expect(readThrottleConfig(undefined)).to.deep.eq(DEFAULT_THROTTLE);
    expect(DEFAULT_THROTTLE_PARAMS).to.deep.eq(DEFAULT_THROTTLE);
  });

  it('merges per flow and key kind over the defaults', () => {
    const p = readThrottleConfig({ login: { account: { free: 2 } }, resetAfterSeconds: 60 });
    expect(p.login.account).to.deep.eq({ free: 2, baseDelayMs: 1000, maxDelayMs: 60000 });
    expect(p.login.ip).to.deep.eq(DEFAULT_THROTTLE.login.ip);
    expect(p.mfa).to.deep.eq(DEFAULT_THROTTLE.mfa);
    expect(p.resetAfterSeconds).to.eq(60);
    expect(p.global).to.eq(null);
  });

  it('allows and ignores service and maxRows', () => {
    expect(readThrottleConfig({ service: 'DbAuthnThrottle', maxRows: 10 })).to.deep.eq(DEFAULT_THROTTLE);
  });

  it('throws InvalidOption on an unknown key at any level', () => {
    expect(() => readThrottleConfig({ logins: {} })).to.throw(InvalidOption);
    expect(() => readThrottleConfig({ login: { acount: { free: 1 } } })).to.throw(InvalidOption);
    expect(() => readThrottleConfig({ login: { account: { fre: 1 } } })).to.throw(InvalidOption);
    expect(() => checkThrottleParams({ ...DEFAULT_THROTTLE, extra: 1 } as never)).to.throw(InvalidOption);
  });

  it('throws InvalidOption on a bad value', () => {
    expect(() => readThrottleConfig({ login: { account: { free: -1 } } })).to.throw(InvalidOption);
    expect(() => readThrottleConfig({ resetAfterSeconds: 0 })).to.throw(InvalidOption);
    expect(() => readThrottleConfig({ global: { free: 1 } })).to.throw(InvalidOption);
  });

  it('computes the backoff delay after counted attempt n', () => {
    const p = { free: 5, baseDelayMs: 1000, maxDelayMs: 60000 };
    expect([1, 4, 5, 6, 7, 11, 12].map((n) => backoffDelayMs(p, n))).to.deep.eq([0, 0, 1000, 2000, 4000, 60000, 60000]);
  });
});
