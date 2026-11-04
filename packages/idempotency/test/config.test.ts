import 'mocha';
import { expect } from 'chai';
import assert from 'node:assert/strict';
import { Configuration } from '@spinajs/configuration';
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

  it('refuses a lease that is not a duration and a sweepBatch below 1', async () => {
    for (const idempotency of [{ lease: 'soon' }, { sweepBatch: 0 }, { sweepEvery: 'often' }]) {
      await assert.rejects(bootIdempotencyApp({ idempotency }), JSON.stringify(idempotency));
    }
  });
});
