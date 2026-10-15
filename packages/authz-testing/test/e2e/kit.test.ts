import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { E2E_DIALECTS, e2eHarness, withPostgres } from './support/stack.js';

// The kit parts that need real list SQL: B06 over .accessible() (RBAC, ancestors, owner, wildcard, deny, expiry),
// B20/B21 (.accessible, .withAccess, the guard, bulk writes), B09.orm (unattended, runAs(SYSTEM)).
for (const kind of E2E_DIALECTS) {
  describe(`e2e kit fixtures (${kind})`, function () {
    this.timeout(120_000);
    before(async function () {
      await withPostgres(this, kind);
    });
    runBehaviour(['B06.accessible', 'B20.orm', 'B21.orm', 'B09.orm'], () => e2eHarness(kind), { strict: true });
  });
}
