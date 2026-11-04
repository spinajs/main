import assert from 'node:assert/strict';
import { InvalidArgument } from '@spinajs/exceptions';
import type { IdempotencyStore } from '../store.js';
import type { IdempotencyClaimOptions, StoredReply } from '../interfaces.js';

interface Bdd {
  describe(title: string, fn: () => void): void;
  it(title: string, fn: () => Promise<void>): void;
}

// mocha's globals; the package takes mocha as an optional peer, so it is not imported.
const bdd = globalThis as unknown as Bdd;

// Past 2^31 on purpose: a 32-bit time column fails here.
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const LEASE = 1_000;
const TTL = 60_000;
const REPLY: StoredReply = { kind: 'test', body: { n: 1, items: [1] } };
const OTHER_TOKEN = '00000000-0000-4000-8000-000000000000';

const at = (now: number, fingerprint?: string): IdempotencyClaimOptions => ({ leaseMs: LEASE, now, namespace: 'conformance', ...(fingerprint === undefined ? {} : { fingerprint }) });

async function claimed(store: IdempotencyStore, key: string, now: number, fingerprint?: string): Promise<string> {
  const claim = await store.claim(key, at(now, fingerprint));
  assert.equal(claim.state, 'claimed', `${key} should be free at ${now}`);
  return (claim as { token: string }).token;
}

/** The contract every IdempotencyStore keeps. `factory` answers an empty store for each case. */
export function describeIdempotencyStoreConformance(name: string, factory: () => IdempotencyStore | Promise<IdempotencyStore>): void {
  const it = (title: string, body: (store: IdempotencyStore) => Promise<void>): void => bdd.it(title, async () => body(await factory()));

  bdd.describe(`${name}: IdempotencyStore conformance`, () => {
    it('claims a free key with a fresh token', async (store) => {
      const a = await claimed(store, 'k1', T0);
      const b = await claimed(store, 'k2', T0);
      assert.match(a, /^[0-9a-f-]{36}$/);
      assert.notEqual(a, b);
    });

    it('answers running with the lease end while the lease holds, at its last millisecond too', async (store) => {
      await claimed(store, 'k', T0);
      assert.deepEqual(await store.claim('k', at(T0 + LEASE)), { state: 'running', leaseUntil: T0 + LEASE });
    });

    it('carries the fingerprint of a running claim, so a repeat with another request is refused before the call ends', async (store) => {
      const fingerprint = 'f'.repeat(64);
      await claimed(store, 'k', T0, fingerprint);
      assert.deepEqual(await store.claim('k', at(T0 + 1, 'e'.repeat(64))), { state: 'running', leaseUntil: T0 + LEASE, fingerprint });
      assert.deepEqual(await store.peek('k', T0 + 1), { state: 'running', leaseUntil: T0 + LEASE, fingerprint });
    });

    it('gives exactly one of many concurrent claims the key', async (store) => {
      const claims = await Promise.all(Array.from({ length: 10 }, () => store.claim('k', at(T0))));
      assert.equal(claims.filter((c) => c.state === 'claimed').length, 1);
      assert.deepEqual(
        claims.filter((c) => c.state !== 'claimed'),
        Array.from({ length: 9 }, () => ({ state: 'running', leaseUntil: T0 + LEASE })),
      );
    });

    it('replays a completed reply and its fingerprint until the TTL passes', async (store) => {
      const fingerprint = 'f'.repeat(64);
      const token = await claimed(store, 'k', T0, fingerprint);
      assert.equal(await store.complete('k', token, REPLY, TTL, T0 + 10), true);
      assert.deepEqual(await store.claim('k', at(T0 + 10 + TTL - 1)), { state: 'done', reply: REPLY, fingerprint });
      assert.equal(await store.peek('k', T0 + 10 + TTL), undefined);
      assert.equal((await store.claim('k', at(T0 + 10 + TTL))).state, 'claimed');
    });

    it('completes a claim once', async (store) => {
      const token = await claimed(store, 'k', T0);
      assert.equal(await store.complete('k', token, REPLY, TTL, T0), true);
      assert.equal(await store.complete('k', token, { kind: 'test', body: 'second' }, TTL, T0), false);
      assert.deepEqual(await store.peek('k', T0), { state: 'done', reply: REPLY });
    });

    it('refuses to renew a completed key', async (store) => {
      const token = await claimed(store, 'k', T0);
      await store.complete('k', token, REPLY, TTL, T0);
      assert.equal(await store.renew('k', token, LEASE, T0), false);
    });

    it('stores a reply as its JSON text would read back', async (store) => {
      const token = await claimed(store, 'k', T0);
      await store.complete('k', token, { kind: 'test', body: { at: new Date(T0), gone: undefined, n: 1 } }, TTL, T0);
      assert.deepEqual(await store.peek('k', T0), { state: 'done', reply: { kind: 'test', body: { at: new Date(T0).toISOString(), n: 1 } } });
    });

    it('treats an empty fingerprint as none', async (store) => {
      const token = await claimed(store, 'k', T0, '');
      assert.deepEqual(await store.peek('k', T0), { state: 'running', leaseUntil: T0 + LEASE });
      await store.complete('k', token, REPLY, TTL, T0);
      assert.deepEqual(await store.peek('k', T0), { state: 'done', reply: REPLY });
    });

    it('rejects a lease or TTL that is not a finite number above 0', async (store) => {
      const token = await claimed(store, 'k', T0);
      for (const ms of [Number.NaN, 0, Number.POSITIVE_INFINITY]) {
        await assert.rejects(store.claim('other', { leaseMs: ms, now: T0 }), InvalidArgument, `claim ${ms}`);
        await assert.rejects(store.renew('k', token, ms, T0), InvalidArgument, `renew ${ms}`);
        await assert.rejects(store.complete('k', token, REPLY, ms, T0), InvalidArgument, `complete ${ms}`);
      }
      assert.equal(await store.peek('other', T0), undefined);
      assert.deepEqual(await store.peek('k', T0), { state: 'running', leaseUntil: T0 + LEASE });
    });

    it('stores no fingerprint when the claim had none', async (store) => {
      const token = await claimed(store, 'k', T0);
      await store.complete('k', token, REPLY, TTL, T0);
      assert.deepEqual(await store.peek('k', T0), { state: 'done', reply: REPLY });
    });

    it('refuses complete, renew and release with another token', async (store) => {
      const token = await claimed(store, 'k', T0);
      assert.equal(await store.complete('k', OTHER_TOKEN, REPLY, TTL, T0), false);
      assert.equal(await store.renew('k', OTHER_TOKEN, LEASE, T0), false);
      await store.release('k', OTHER_TOKEN);
      assert.deepEqual(await store.peek('k', T0), { state: 'running', leaseUntil: T0 + LEASE });
      assert.equal(await store.complete('k', token, REPLY, TTL, T0), true);
    });

    it('lets another caller take an ended lease over and fences the old holder out', async (store) => {
      const old = await claimed(store, 'k', T0);
      const fresh = await claimed(store, 'k', T0 + LEASE + 1);
      assert.notEqual(fresh, old);
      assert.equal(await store.renew('k', old, LEASE, T0 + LEASE + 2), false);
      assert.equal(await store.complete('k', old, REPLY, TTL, T0 + LEASE + 2), false);
      assert.equal(await store.complete('k', fresh, REPLY, TTL, T0 + LEASE + 2), true);
    });

    it('accepts the old holder past its lease until another caller claims the key', async (store) => {
      const late = await claimed(store, 'late', T0);
      assert.equal(await store.complete('late', late, REPLY, TTL, T0 + LEASE + 5), true);
      assert.equal((await store.peek('late', T0 + LEASE + 5))?.state, 'done');

      const old = await claimed(store, 'k', T0);
      assert.equal(await store.renew('k', old, LEASE, T0 + LEASE + 5), true);
      await claimed(store, 'k', T0 + 2 * LEASE + 6);
      assert.equal(await store.renew('k', old, LEASE, T0 + 2 * LEASE + 7), false);
      assert.equal(await store.complete('k', old, REPLY, TTL, T0 + 2 * LEASE + 7), false);
    });

    it('extends the lease on renew', async (store) => {
      const token = await claimed(store, 'k', T0);
      assert.equal(await store.renew('k', token, LEASE, T0 + 900), true);
      assert.deepEqual(await store.claim('k', at(T0 + 1_500)), { state: 'running', leaseUntil: T0 + 1_900 });
    });

    it('frees a released claim but never a completed key', async (store) => {
      const a = await claimed(store, 'a', T0);
      await store.release('a', a);
      assert.equal(await store.peek('a', T0), undefined);
      await claimed(store, 'a', T0);

      const b = await claimed(store, 'b', T0);
      await store.complete('b', b, REPLY, TTL, T0);
      await store.release('b', b);
      assert.equal((await store.peek('b', T0))?.state, 'done');
    });

    it('keeps its own copy of a reply', async (store) => {
      const body = { items: [1] };
      const token = await claimed(store, 'k', T0);
      await store.complete('k', token, { kind: 'test', body }, TTL, T0);
      body.items.push(2);
      const first = (await store.peek('k', T0)) as { reply: StoredReply };
      (first.reply.body as { items: number[] }).items.push(3);
      assert.deepEqual(await store.peek('k', T0), { state: 'done', reply: { kind: 'test', body: { items: [1] } } });
    });

    it('peeks without claiming', async (store) => {
      assert.equal(await store.peek('k', T0), undefined);
      assert.equal((await store.claim('k', at(T0))).state, 'claimed');
      assert.deepEqual(await store.peek('k', T0 + LEASE + 1), undefined);
    });

    it('sweeps expired replies and ended claims up to the limit, and nothing live', async (store) => {
      for (const key of ['d1', 'd2', 'd3']) {
        const token = await claimed(store, key, T0);
        await store.complete(key, token, REPLY, 10, T0);
      }
      await claimed(store, 'ended', T0);
      await claimed(store, 'live', T0 + 900);
      const kept = await claimed(store, 'kept', T0);
      await store.complete('kept', kept, REPLY, TTL, T0);

      const now = T0 + LEASE + 1;
      assert.equal(await store.sweep(now, 2), 2);
      assert.equal(await store.sweep(now, 10), 2);
      assert.equal(await store.sweep(now, 10), 0);
      assert.equal((await store.peek('live', now))?.state, 'running');
      assert.equal((await store.peek('kept', now))?.state, 'done');
    });
  });
}
