import 'mocha';
import { expect } from 'chai';

import { buildOtpAuthUrl } from '../src/2fa/otpUrl.js';

const DEFAULTS = {
  issuer: 'Spinajs',
  label: 'user',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
};

describe('buildOtpAuthUrl', () => {
  it('builds otpauth url from base32 secret with given options', () => {
    const url = buildOtpAuthUrl('JBSWY3DPEHPK3PXP', DEFAULTS);

    expect(url).to.match(/^otpauth:\/\/totp\//);
    expect(url).to.include('secret=JBSWY3DPEHPK3PXP');
    expect(url).to.include('issuer=Spinajs');
    expect(url).to.include('algorithm=SHA1');
    expect(url).to.include('digits=6');
    expect(url).to.include('period=30');
    expect(url).to.include('user');
  });

  it('normalizes lowercase and whitespace-separated secret', () => {
    const url = buildOtpAuthUrl('jbsw y3dp ehpk 3pxp', DEFAULTS);
    expect(url).to.include('secret=JBSWY3DPEHPK3PXP');
  });

  it('passes full otpauth url through untouched', () => {
    const input = 'otpauth://totp/ACME:Alice?issuer=ACME&secret=US3WHSG7X5KAPV27VANWKQHF3SH3HULL&algorithm=SHA1&digits=6&period=30';
    expect(buildOtpAuthUrl(input, DEFAULTS)).to.equal(input);
  });

  it('throws on invalid base32 secret', () => {
    expect(() => buildOtpAuthUrl('not-a-secret-01', DEFAULTS)).to.throw();
  });

  it('throws on empty input', () => {
    expect(() => buildOtpAuthUrl('   ', DEFAULTS)).to.throw();
  });
});
