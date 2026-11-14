import 'mocha';
import { expect } from 'chai';
import type { TestApp } from '@spinajs/testing';
import { IdempotencyKeyModel, OrmIdempotencyStore } from '../src/index.js';
import { describeIdempotencyStoreConformance } from '../src/testing/index.js';
import { bootIdempotencyApp } from './support/app.js';

describe('OrmIdempotencyStore (sqlite)', function () {
  this.timeout(30_000);

  let app: TestApp;

  before(async () => {
    app = await bootIdempotencyApp();
  });

  after(() => app.dispose());

  const emptyStore = async (): Promise<OrmIdempotencyStore> => {
    await IdempotencyKeyModel.destroy().where('Key', '!=', '');
    return app.resolve(OrmIdempotencyStore);
  };

  describeIdempotencyStoreConformance('OrmIdempotencyStore (sqlite)', emptyStore);

  it('writes BIGINT times past 2^31, the fingerprint and the namespace cut to 128 characters', async () => {
    const store = await emptyStore();
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    await store.claim('k', { leaseMs: 1_000, now, fingerprint: 'f'.repeat(64), namespace: 'n'.repeat(140) });

    const [row] = await IdempotencyKeyModel.where('Key', 'k');
    expect(Number(row.LeaseUntil)).to.equal(now + 1_000);
    expect(Number(row.CreatedAt)).to.equal(now);
    expect(row.Namespace).to.equal('n'.repeat(128));
    expect(row.Fingerprint).to.equal('f'.repeat(64));
    expect(row.State).to.equal('running');
    expect(row.Reply).to.equal(null);
  });
});
