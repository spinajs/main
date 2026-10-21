import 'mocha';

import { startApp, stopApp } from './app.js';
import { codeGateSuite, codeRoutesSuite } from './suites/code.js';

// Sorts before behaviour/, like auth-password.test.ts: authn-local's PasswordService registers after this one there.
describe('3.0 email code routes (FEAT-3)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('the code gate', codeGateSuite);
  describe('over a recording PasswordService', codeRoutesSuite);
});
