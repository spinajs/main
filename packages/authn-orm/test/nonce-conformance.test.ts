import { runNonceStoreConformance } from '@spinajs/authn-testing';
import { QueryContext } from '@spinajs/orm';
import 'mocha';

import { DbNonceStore } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

for (const kind of DB_KINDS) {
  describe(`DbNonceStore conformance (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'nonce_conf');
    });

    after(async () => {
      await db?.dispose();
    });

    runNonceStoreConformance(
      `nonce store conformance (${kind})`,
      async () => {
        await rawQuery(db.driver, 'DELETE FROM authn_nonce', [], QueryContext.Delete);
        return new DbNonceStore();
      },
      { timeoutMs: 30000 },
    );
  });
}
