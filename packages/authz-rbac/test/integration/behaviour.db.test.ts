import 'mocha';
import { runBehaviour } from '@spinajs/authz-testing';

import { bootDb, DB_KINDS } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { dbHarness } from './db-harness.js';

const RUN = { strict: true, timeoutMs: 60_000 };

for (const kind of DB_KINDS) {
  describe(`authz-rbac DB stores in the behaviour fixtures (${kind})`, function () {
    this.timeout(120_000);

    let db: TestDb | undefined;

    before(async function () {
      db = await bootDb(this, kind, 'behaviour');
    });

    after(async () => {
      await db?.dispose();
    });

    // The store parts L2 owns: ConfigRoleStore and DbAssignmentStore under the RbacModel.
    runBehaviour(['B12.store', 'B14.store'], () => dbHarness(() => db), RUN);

    // The write parts: AuthzAdmin on DbAuthzAdminBackend with the DB stores, then checks through the RbacModel.
    runBehaviour(['B12.write', 'B13.write', 'B27.store', 'B43.rules'], () => dbHarness(() => db, { admin: true }), RUN);

    describe("parity, not claimed: L1's model parts on the DB stores", () => {
      runBehaviour(['B01.rbac', 'B11.rbac', 'B13.rbac', 'B14.rbac'], () => dbHarness(() => db), RUN);
    });

    describe("parity, not claimed: L9's AuthzAdmin parts on the DB backend and stores (L9's TestRbacModel)", () => {
      runBehaviour(['B26.guard', 'B27.events', 'B43.admin', 'B43.events'], () => dbHarness(() => db, { admin: true, model: 'test' }), RUN);
    });

    // L1b's link principal over DbLinkStore.byToken.
    runBehaviour(['B38.store'], () => dbHarness(() => db, { facets: ['links'] }), RUN);
  });
}
