import 'mocha';

import { bootPostgres, bootSqlite, createSchema, executionCases, parityCases, seed } from './fixture.js';
import type { BootedDb } from './fixture.js';

describe('authz-rbac orm: native:rbac.assignment on sqlite', function () {
  this.timeout(30000);

  let db: BootedDb;

  before(async () => {
    db = await bootSqlite();
    await createSchema(db.driver);
    await seed(db.driver);
  });

  after(async () => {
    await db?.close();
  });

  executionCases(() => db.driver);
  parityCases(() => db.driver);
});

describe('authz-rbac orm: native:rbac.assignment on postgres', function () {
  this.timeout(60000);

  let db: BootedDb | null = null;

  before(async function () {
    db = await bootPostgres();
    if (!db) {
      if (process.env.L2_REQUIRE_PG === '1') {
        throw new Error('L2_REQUIRE_PG=1 but the postgres server at 127.0.0.1:15432 is unreachable');
      }
      console.warn('    skipped: postgres at 127.0.0.1:15432 is unreachable (set L2_REQUIRE_PG=1 to fail instead)');
      this.skip();
    }
    await createSchema(db.driver);
    await seed(db.driver);
  });

  after(async () => {
    await db?.close();
  });

  executionCases(() => db!.driver);
  parityCases(() => db!.driver);
});

describe('authz-rbac orm: native:rbac.assignment through authz-orm', () => {
  it('with @ScopeColumn metadata from authz-orm (after L4)');
});
