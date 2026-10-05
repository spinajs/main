import 'mocha';

import { startApp, stopApp } from './app.js';
import { mfaEnrolmentGateSuite } from './suites/mfa-enrolment.js';

// The routes over the real TotpService run in behaviour/n8b.test.ts; with and without authn-totp in
// test/v3/route-groups-boot.test.ts.
describe('3.0 MFA enrolment routes (N8b task 2)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('the TotpService gate', mfaEnrolmentGateSuite);
});
