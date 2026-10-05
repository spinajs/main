import 'mocha';

import { startApp, stopApp } from './app.js';
import { mfaEnrolmentGateSuite } from './suites/mfa-enrolment.js';

// Sorts before behaviour/, whose N8b harness loads authn-totp: TotpService is still unregistered here. The routes over
// the real TotpService run in behaviour/n8b.test.ts.
describe('3.0 MFA enrolment routes (N8b task 2)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('without a TotpService', mfaEnrolmentGateSuite);
});
