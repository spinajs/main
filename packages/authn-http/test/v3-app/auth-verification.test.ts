import 'mocha';

import { startApp, stopApp } from './app.js';
import { verificationRoutesSuite } from './suites/verification.js';

// Sorts before behaviour/, like auth-password.test.ts: authn-local's PasswordService registers after this one there.
describe('3.0 address verification routes (FEAT-2)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('over a recording PasswordService', verificationRoutesSuite);
});
