import 'mocha';
import { expect } from 'chai';

import shipped from '../../src/config/authn-http.js';

describe('authn-http shipped config', () => {
  it('ships no 2.x rbac keys, so no lockout setting (H31: backoff in the authn throttle, never a lock)', () => {
    expect(shipped).to.not.have.property('rbac');
    expect(JSON.stringify(shipped)).to.not.match(/blockAfterAttempts|lockoutTime/);
  });

  it('scans its cli dir, so authn:check-config is on in every app', () => {
    const dirs = (shipped.system.dirs as { cli?: string[] }).cli ?? [];
    expect(dirs.map((d) => d.replace(/\\/g, '/'))).to.satisfy((list: string[]) => list.some((d) => /\/@spinajs\/authn-http\/lib\/(mjs|cjs)\/cli$/.test(d)));
  });
});
