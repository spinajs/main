import assert from 'node:assert/strict';
import 'mocha';
import { DI } from '@spinajs/di';

import { CredentialChangeBus, InProcessCredentialChangeBus, credentialChangeTags, credentialTag, identityTag } from '../../src/index.js';
import type { CredentialChange } from '../../src/index.js';

const ALICE = { type: 'user', id: 'alice' };

describe('InProcessCredentialChangeBus', () => {
  it('delivers a published change to every subscriber before publish settles', async () => {
    const bus = new InProcessCredentialChangeBus();
    const a: CredentialChange[] = [];
    const b: CredentialChange[] = [];
    bus.subscribe((c) => a.push(c));
    bus.subscribe((c) => b.push(c));

    const change: CredentialChange = { kind: 'token', id: 't-1' };
    await bus.publish(change);

    assert.deepStrictEqual(a, [change]);
    assert.deepStrictEqual(b, [change]);
  });

  it('stops delivering to a listener once it unsubscribes, and an unsubscribe twice is harmless', async () => {
    const bus = new InProcessCredentialChangeBus();
    const seen: CredentialChange[] = [];
    const off = bus.subscribe((c) => seen.push(c));

    await bus.publish({ kind: 'key', id: 'k-1' });
    off();
    off();
    await bus.publish({ kind: 'key', id: 'k-2' });

    assert.deepStrictEqual(seen, [{ kind: 'key', id: 'k-1' }]);
  });

  it('keeps delivering when a listener throws, and publish does not reject', async () => {
    const bus = new InProcessCredentialChangeBus();
    const seen: CredentialChange[] = [];
    bus.subscribe(() => {
      throw new Error('listener failure');
    });
    bus.subscribe((c) => seen.push(c));

    await bus.publish({ kind: 'identity', identity: ALICE });

    assert.deepStrictEqual(seen, [{ kind: 'identity', identity: ALICE }]);
  });

  it('is the default CredentialChangeBus, one per container', async () => {
    const first = await DI.resolve(CredentialChangeBus);
    const second = await DI.resolve(CredentialChangeBus);
    assert.ok(first instanceof InProcessCredentialChangeBus);
    assert.strictEqual(first, second);
  });
});

describe('credential change tags', () => {
  it('maps a token or key change to its credential tag and an identity change to the identity tag', () => {
    assert.deepStrictEqual(credentialChangeTags({ kind: 'token', id: 't-1' }), [credentialTag('token', 't-1')]);
    assert.deepStrictEqual(credentialChangeTags({ kind: 'key', id: 'k-1' }), [credentialTag('key', 'k-1')]);
    assert.deepStrictEqual(credentialChangeTags({ kind: 'identity', identity: ALICE }), [identityTag(ALICE)]);
  });

  it('never gives a token, a key and identities that differ in type or id the same tag', () => {
    const tags = [credentialTag('token', 'x'), credentialTag('key', 'x'), identityTag({ type: 'user', id: 'x' }), identityTag({ type: 'service', id: 'x' }), identityTag({ type: 'user', id: 'y' }), identityTag({ type: 'user:x', id: '' })];
    assert.strictEqual(new Set(tags).size, tags.length);
  });
});
