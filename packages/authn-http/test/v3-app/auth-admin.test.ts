import 'mocha';

import { startApp, stopApp } from './app.js';
import { credentialAdminGateSuite } from './suites/credential-admin.js';

// Sorts before behaviour/, whose lane registers a CredentialAdminGuard for the rest of the process. The routes behind
// the guard run in behaviour/n8b.test.ts; with and without a guard in test/v3/route-groups-boot.test.ts.
describe('3.0 credential admin routes (N8b task 5)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('the CredentialAdminGuard gate', credentialAdminGateSuite);
});
