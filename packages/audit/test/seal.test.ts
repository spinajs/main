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
    for (const changed of [{ id: '00000000-0000-4000-8000-000000000002' }, { kind: 'data' }, { action: 'contract.voided' }, { outcome: 'denied' }, { subject: { type: 'contract', id: 'c2' } }, { subject: { type: 'order', id: 'c1' } }]) {
      expect(eventDigest({ ...sealed, ...changed }, payloadHash({ v: 1 })), JSON.stringify(changed)).to.not.eq(base);
    }
  });

  // Seals are stored: a change of the encoding must fail here before it fails every existing chain.
  it('keeps its encoding', () => {
    const digest = eventDigest(sealed, payloadHash({ v: 1 }));
    expect(digest).to.eq('b8dbdea84e850dff3598ccaa3f39352ef1771583bd9ae2117b4f82ab08be2709');
    expect(sealHash(null, [digest])).to.eq('46457b59eeab1983a766b1cc83633290eca89f251bb714ea2644fb52edf52b33');
    expect(sealHash(digest, [digest])).to.eq('902bdefb1e037acb0f645ccd5600a8bca0a06c41cb7b22ebd44fd39fd17dc875');
  });

  it('chains a seal to the one before it', () => {
    const first = sealHash(null, ['a', 'b']);
    expect(sealHash(null, ['a', 'b'])).to.eq(first);
    expect(sealHash(null, ['b', 'a'])).to.not.eq(first);
    expect(sealHash(first, ['c'])).to.not.eq(sealHash(null, ['c']));
  });
});
