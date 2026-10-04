import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { TestDb } from './support/db.js';
import { ormHarness } from './support/b06.js';

// The kit's B06.sql: its agree worlds with the rows in ORM tables, the check against the
// middleware's select; native:fake.tuple through the test compiler of support/b06.ts.
describe('authz-orm behaviour B06.sql', function () {
  this.timeout(120000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      runBehaviour(['B06.sql'], () => ormHarness(() => db, dialect));
    });
  }
});
