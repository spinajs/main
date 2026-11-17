import { expect } from 'chai';
import 'mocha';
import { eventDigest, payloadHash, sealHash } from '../src/index.js';

describe('seal hashing', () => {
  const sealed = { id: '00000000-0000-4000-8000-000000000001', at: new Date('2026-11-16T10:00:01.000Z'), kind: 'custom', action: 'contract.signed', subject: { type: 'contract', id: 'c1' }, outcome: 'ok', actor: 'user:u1' };

  it('covers every sealed field of an event, and its payload through the hash', () => {
    const base = eventDigest(sealed, payloadHash({ v: 1 }));
    expect(base).to.match(/^[0-9a-f]{64}$/);
    expect(eventDigest({ ...sealed, actor: 'user:u2' }, payloadHash({ v: 1 }))).to.not.eq(base);
    expect(eventDigest({ ...sealed, at: new Date(sealed.at.getTime() + 1) }, payloadHash({ v: 1 }))).to.not.eq(base);
    expect(eventDigest({ ...sealed, subject: undefined }, payloadHash({ v: 1 }))).to.not.eq(base);
    expect(eventDigest(sealed, payloadHash({ v: 2 }))).to.not.eq(base);
  });

  it('chains a seal to the one before it', () => {
    const first = sealHash(null, ['a', 'b']);
    expect(sealHash(null, ['a', 'b'])).to.eq(first);
    expect(sealHash(null, ['b', 'a'])).to.not.eq(first);
    expect(sealHash(first, ['c'])).to.not.eq(sealHash(null, ['c']));
  });
});
