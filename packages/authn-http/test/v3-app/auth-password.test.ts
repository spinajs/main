import 'mocha';

import { startApp, stopApp } from './app.js';
import { passwordGateSuite, passwordRoutesSuite } from './suites/password.js';

// Sorts after account.test.ts and before behaviour/: nothing registers a PasswordService before the gate cases, and
// behaviour/n8b.test.ts loads the real one only after them.
describe('3.0 password routes (N8b task 1)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('without a PasswordService', passwordGateSuite);
  describe('over a recording PasswordService', passwordRoutesSuite);
});
