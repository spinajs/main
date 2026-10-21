import assert from 'node:assert/strict';
import type { NonceStore } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';
import { burst } from '../helpers/concurrency.js';
import { conformanceSuite } from './run.js';
import type { ConformanceOptions } from './run.js';

const T0 = Date.parse('2026-06-01T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const KEY_MAX = 160;

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

/** Each case gets a store from `make` that holds no claims. */
export function runNonceStoreConformance(name: string, make: () => Promise<NonceStore>, opts: ConformanceOptions = {}): void {
  conformanceSuite(name, make, opts, false, (kase) => {
    kase('the first claim of a key is true and the second is false', async (store) => {
      assert.strictEqual(await store.claim('jti:1', at(60), at(0)), true);
      assert.strictEqual(await store.claim('jti:1', at(60), at(0)), false);
      assert.strictEqual(await store.claim('jti:1', at(120), at(59)), false, 'a later expiry does not extend a live claim');
    });

    kase('keys are independent', async (store) => {
      assert.strictEqual(await store.claim('jti:a', at(60), at(0)), true);
      assert.strictEqual(await store.claim('jti:b', at(60), at(0)), true);
    });

    kase('of 10 parallel claims of one key exactly one wins', async (store) => {
      const results = await burst(10, () => store.claim('race', at(60), at(0)));
      assert.strictEqual(results.rejected().length, 0);
      assert.strictEqual(results.count((won) => won), 1);
    });

    kase('an expired key can be claimed again, once', async (store) => {
      assert.strictEqual(await store.claim('exp', at(60), at(0)), true);
      assert.strictEqual(await store.claim('exp', at(120), at(60)), true, 'live until expiresAt, not including it');
      assert.strictEqual(await store.claim('exp', at(120), at(61)), false);
    });

    kase('of 10 parallel claims over an expired key exactly one takes it over', async (store) => {
      assert.strictEqual(await store.claim('race-exp', at(10), at(0)), true);
      const results = await burst(10, () => store.claim('race-exp', at(60), at(10)));
      assert.strictEqual(results.rejected().length, 0);
      assert.strictEqual(results.count((won) => won), 1);
    });

    kase('an expiresAt at or before now is never live', async (store) => {
      assert.strictEqual(await store.claim('dead', at(0), at(0)), true);
      assert.strictEqual(await store.claim('dead', at(0), at(0)), true);
      assert.strictEqual(await store.claim('past', at(-5), at(0)), true);
      assert.strictEqual(await store.claim('past', at(-5), at(0)), true);
    });

    kase('a key of 160 characters is accepted and 161 throws InvalidArgument', async (store) => {
      assert.strictEqual(await store.claim('k'.repeat(KEY_MAX), at(60), at(0)), true);
      assert.ok((await rejection(store.claim('k'.repeat(KEY_MAX + 1), at(60), at(0)))) instanceof InvalidArgument);
    });
  });
}
