import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';

import { hashesEqual, invitationTokenHash, newInvitationToken, readInvitationSecret } from '../../src/invitations/token.js';

const expect = chai.expect;
const SECRET = 'x'.repeat(32);

describe('invitation tokens', () => {
  it('are 32 random bytes, base64url, stored only as a keyed hash', () => {
    const a = newInvitationToken();
    expect(a).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(newInvitationToken()).to.not.equal(a);
    const h = invitationTokenHash(SECRET, a);
    expect(h).to.match(/^v1:[0-9a-f]{64}$/);
    expect(invitationTokenHash(SECRET, a)).to.equal(h);
    expect(invitationTokenHash('y'.repeat(32), a)).to.not.equal(h);
    expect(hashesEqual(h, invitationTokenHash(SECRET, a))).to.equal(true);
    expect(hashesEqual(h, 'v1:00')).to.equal(false);
  });

  it('needs a secret of at least 32 characters', () => {
    expect(readInvitationSecret(SECRET)).to.equal(SECRET);
    expect(() => readInvitationSecret(undefined)).to.throw(AuthzConfigError, /teams\.invitations\.secret/);
    expect(() => readInvitationSecret('short')).to.throw(AuthzConfigError);
  });
});
