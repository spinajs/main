import 'mocha';
import { expect } from 'chai';
import type { KeyRecord } from '@spinajs/authn/contracts';
// The request-context augmentation that src/keys/fields.ts compiles against.
import '../../src/api.js';
import { keyEntry } from '../../src/keys/fields.js';

describe('the key listing entry of a key whose instants no converter reads', () => {
  const base: KeyRecord = { kid: 'k-1', owner: { type: 'user', id: 'u' }, alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, thumbprint: 't', createdAt: new Date('2026-01-01T00:00:00Z') };
  const now = new Date('2026-06-01T00:00:00Z');

  it('marks an unreadable revocation as revoked and an unreadable expiry as expired, with null instants, instead of throwing', () => {
    const revoked = keyEntry({ ...base, revokedAt: new Date(NaN) }, now);
    const expired = keyEntry({ ...base, expiresAt: new Date(NaN) }, now);

    expect([revoked.revoked, revoked.revokedAt, revoked.expired, expired.expired, expired.expiresAt, expired.revoked]).to.deep.equal([true, null, false, true, null, false]);
  });

  it('gives an unreadable creation time as null instead of throwing', () => {
    expect(keyEntry({ ...base, createdAt: new Date(NaN) }, now)).to.include({ createdAt: null, revoked: false, expired: false });
  });

  it('keeps the entry of a key with readable instants as it was', () => {
    expect(keyEntry(base, now)).to.include({ revoked: false, expired: false, expiresAt: null, revokedAt: null });
    expect(keyEntry({ ...base, expiresAt: now }, now)).to.include({ expired: true, expiresAt: '2026-06-01T00:00:00.000Z' });
    expect(keyEntry({ ...base, expiresAt: new Date('2026-06-01T00:00:01.500Z') }, now)).to.include({ expired: false, expiresAt: '2026-06-01T00:00:01.000Z' });
  });
});
