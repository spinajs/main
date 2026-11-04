import 'mocha';
import { expect } from 'chai';
import assert from 'node:assert/strict';
import { Configuration } from '@spinajs/configuration';
import { IdempotencyService } from '../src/index.js';
import { bootIdempotencyApp } from './support/app.js';

describe('idempotency configuration', function () {
  this.timeout(30_000);

  it('fills the defaults', async () => {
    const app = await bootIdempotencyApp({ idempotency: {} });
    try {
      expect((await app.resolve(Configuration)).get('idempotency')).to.deep.equal({ store: 'OrmIdempotencyStore', lease: '30s', sweepBatch: 500, sweepEvery: '5m' });
    } finally {
      await app.dispose();
    }
  });

  it('takes a lease in milliseconds as well as a duration', async () => {
    for (const [lease, ms] of [[45_000, 45_000], ['1.5s', 1_500]] as const) {
      const app = await bootIdempotencyApp({ idempotency: { store: 'MemoryIdempotencyStore', lease } });
      try {
        expect((await app.resolve(IdempotencyService)).LeaseMs, String(lease)).to.equal(ms);
      } finally {
        await app.dispose();
      }
    }
  });

  it('refuses a lease that is not a positive duration or millisecond count, and a sweepBatch below 1', async () => {
    const refused = [{ lease: 'soon' }, { lease: '0s' }, { lease: '0.0ms' }, { lease: 0 }, { lease: -5 }, { lease: 1.5 }, { sweepBatch: 0 }, { sweepEvery: 'often' }, { sweepEvery: '0m' }];
    for (const idempotency of refused) {
      await assert.rejects(bootIdempotencyApp({ idempotency }), JSON.stringify(idempotency));
    }
  });
});
