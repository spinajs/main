import * as chai from 'chai';
import 'mocha';
import * as util from '@spinajs/util';

import { AUTHN_FAILURE_BODY, CLI_ACTOR, PASSWORD_HARD_CAP, backoffDelayMs, cliContext, identityThrottleKeys, ipKey, sameRef } from '../../src/contracts/index.js';

const expect = chai.expect;

describe('shared authn contracts', () => {
  it('sameRef compares type and id only', () => {
    expect(sameRef({ type: 'user', id: '1' }, { type: 'user', id: '1' })).to.eq(true);
    expect(sameRef({ type: 'user', id: '1' }, { type: 'service', id: '1' })).to.eq(false);
    expect(sameRef({ type: 'user', id: '1' }, { type: 'user', id: '2' })).to.eq(false);
  });

  it('identityThrottleKeys gives the account, account-ip and ip keys', () => {
    const id = { type: 'user', id: 'u1' };
    expect(identityThrottleKeys(id, { now: new Date(0), purpose: 'reauth', ip: '10.0.0.1' })).to.deep.eq([
      { kind: 'account', value: 'u1' },
      { kind: 'account-ip', value: 'u1|10.0.0.1' },
      { kind: 'ip', value: '10.0.0.1' },
    ]);
  });

  it('identityThrottleKeys without an ip shares one account-ip bucket and has no ip key', () => {
    const id = { type: 'user', id: 'u1' };
    const keys = [{ kind: 'account', value: 'u1' }, { kind: 'account-ip', value: 'u1|' }];
    expect(identityThrottleKeys(id, { now: new Date(0), purpose: 'reauth' })).to.deep.eq(keys);
    expect(identityThrottleKeys(id, { now: new Date(0), purpose: 'reauth', ip: '' })).to.deep.eq(keys);
  });

  it('identityThrottleKeys masks an IPv6 address to the given prefix', () => {
    const id = { type: 'user', id: 'u1' };
    const keys = (ip: string) => identityThrottleKeys(id, { now: new Date(0), purpose: 'reauth', ip }, 64);
    expect(keys('2001:db8::1')).to.deep.eq([
      { kind: 'account', value: 'u1' },
      { kind: 'account-ip', value: 'u1|2001:db8::/64' },
      { kind: 'ip', value: '2001:db8::/64' },
    ]);
    expect(keys('2001:db8::ffff')).to.deep.eq(keys('2001:db8::1'));
    expect(keys('2001:db8:0:1::1')).to.not.deep.eq(keys('2001:db8::1'));
    expect(keys('192.0.2.1')[2]).to.deep.eq({ kind: 'ip', value: '192.0.2.1' });
  });

  describe('ipKey', () => {
    const ctx = (ip?: string) => ({ now: new Date(0), purpose: 'request' as const, ...(ip === undefined ? {} : { ip }) });

    it('is the ip key of the masked address, null without an address', () => {
      expect(ipKey(ctx('192.0.2.1'), 64)).to.deep.eq({ kind: 'ip', value: '192.0.2.1' });
      expect(ipKey(ctx('2001:db8::1'), 64)).to.deep.eq({ kind: 'ip', value: '2001:db8::/64' });
      expect(ipKey(ctx('2001:db8::1'), 48)).to.deep.eq({ kind: 'ip', value: '2001:db8::/48' });
      expect(ipKey(ctx(), 64)).to.eq(null);
      expect(ipKey(ctx(''), 64)).to.eq(null);
    });

    it('puts two addresses of one /64 on one key and another /64 on another', () => {
      expect(ipKey(ctx('2001:db8::1'), 64)).to.deep.eq(ipKey(ctx('2001:db8::2'), 64));
      expect(ipKey(ctx('2001:db8:0:1::1'), 64)).to.not.deep.eq(ipKey(ctx('2001:db8::1'), 64));
    });
  });

  it('the CLI actor is a frozen system principal and its context names the CLI', () => {
    expect(CLI_ACTOR).to.deep.eq({ type: 'system', id: 'cli' });
    expect(Object.isFrozen(CLI_ACTOR)).to.eq(true);
    const ctx = cliContext();
    expect(ctx).to.include({ purpose: 'request', userAgent: 'spinajs-cli' });
    expect(ctx.now).to.be.instanceOf(Date);
    expect(cliContext()).to.not.eq(ctx);
  });

  it('the failure body carries the code and the message, frozen', () => {
    expect(JSON.parse(JSON.stringify(AUTHN_FAILURE_BODY))).to.deep.eq({ error: { code: 'E_AUTH_FAILED', message: 'login or password incorrect' }, message: 'login or password incorrect' });
    expect(Object.isFrozen(AUTHN_FAILURE_BODY)).to.eq(true);
    expect(Object.isFrozen(AUTHN_FAILURE_BODY.error)).to.eq(true);
  });

  it('the password hard cap is 1024', () => {
    expect(PASSWORD_HARD_CAP).to.eq(1024);
  });

  it('backoffDelayMs is the one of @spinajs/util', () => {
    expect(backoffDelayMs).to.eq(util.backoffDelayMs);
  });
});
