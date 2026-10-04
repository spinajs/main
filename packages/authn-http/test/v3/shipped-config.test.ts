import 'mocha';
import { expect } from 'chai';

import shipped from '../../src/config/authn-http.js';

describe('authn-http shipped config', () => {
  it('ships no 2.x rbac keys, so no lockout setting (H31: backoff in the authn throttle, never a lock)', () => {
    expect(shipped).to.not.have.property('rbac');
    expect(JSON.stringify(shipped)).to.not.match(/blockAfterAttempts|lockoutTime/);
  });
});
