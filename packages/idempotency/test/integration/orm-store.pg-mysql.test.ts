import 'mocha';
import type { TestApp } from '@spinajs/testing';
import { IdempotencyKeyModel, OrmIdempotencyStore } from '../../src/index.js';
import { describeIdempotencyStoreConformance } from '../../src/testing/index.js';
import { REAL_DB_TARGETS, bootRealDb } from './real-db.js';

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`OrmIdempotencyStore integration (${target.name})`, function () {
    this.timeout(60_000);

    let app: TestApp;

    before(async () => {
      app = await bootRealDb(target);
    });

    after(() => app?.dispose());

    describeIdempotencyStoreConformance(`OrmIdempotencyStore (${target.name})`, async () => {
      await IdempotencyKeyModel.destroy().where('Key', '!=', '');
      return app.resolve(OrmIdempotencyStore);
    });
  });
}
