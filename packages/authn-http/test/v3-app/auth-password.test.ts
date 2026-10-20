import 'mocha';

import { startApp, stopApp } from './app.js';
import { passwordGateSuite, passwordRoutesSuite } from './suites/password.js';

// Sorts before behaviour/: the recording PasswordService registered here must not shadow authn-local's there
// (n8b-harness checks it). With and without authn-local: test/v3/route-groups-boot.test.ts.
describe('3.0 password routes (N8b task 1)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('the PasswordService gate', passwordGateSuite);
  describe('over a recording PasswordService', passwordRoutesSuite);
});
