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
    for (const changed of [{ id: '00000000-0000-4000-8000-000000000002' }, { kind: 'data' }, { action: 'contract.voided' }, { outcome: 'denied' }, { subject: { type: 'contract', id: 'c2' } }, { subject: { type: 'order', id: 'c1' } }, { onBehalfOf: 'user:u9' }, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' }, { origin: '10.0.0.1' }, { tenant: 't2' }, { decisionId: 'd1' }, { idempotencyKey: 'k1' }, { dataSubject: 'person:p1' }, { source: 'orders' }]) {
      expect(eventDigest({ ...sealed, ...changed }, payloadHash({ v: 1 })), JSON.stringify(changed)).to.not.eq(base);
    }
  });

  // Seals are stored: a change of the encoding must fail here before it fails every existing chain.
  it('keeps its encoding', () => {
    const digest = eventDigest(sealed, payloadHash({ v: 1 }));
    expect(digest).to.eq('5f1fcfd1aa34aa1b1a8a980501ab8535e8ef512af170ccb595329f1595c1003f');
    expect(sealHash(null, [digest])).to.eq('cf6c1b6f0f710e05d6cc912243164acb0587ae67333d37689bb7dbc6ffc107b0');
    expect(sealHash(digest, [digest])).to.eq('00f1261522d300b43bc4fe6005ad04139c98122afed5fa42e73f8108edb91d15');
  });

  it('chains a seal to the one before it', () => {
    const first = sealHash(null, ['a', 'b']);
    expect(sealHash(null, ['a', 'b'])).to.eq(first);
    expect(sealHash(null, ['b', 'a'])).to.not.eq(first);
    expect(sealHash(first, ['c'])).to.not.eq(sealHash(null, ['c']));
  });
});
