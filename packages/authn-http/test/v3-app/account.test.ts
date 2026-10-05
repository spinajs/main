import 'mocha';

import { startApp, stopApp, switchHooksOn } from './app.js';
import { groupsOffSuite } from './suites/groups-off.js';
import { loginSuite } from './suites/login.js';
import { mfaSuite } from './suites/mfa.js';
import { sessionsSuite } from './suites/sessions.js';
import { activeRoleSuite } from './suites/active-role.js';
import { impersonationSuite } from './suites/impersonation.js';
import { routeTableSuite } from './suites/route-table.js';

// One app for every suite, in this order: the groups-off cases need RoleSource and ImpersonationGuard unregistered.
describe('3.0 account routes (N8a task 6, test wiring of the N8c cutover)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('route groups without their service', groupsOffSuite);

  describe('with RoleSource and ImpersonationGuard registered', () => {
    before(switchHooksOn);

    describe('login, logout, whoami', loginSuite);
    describe('MFA completion of a pending session', mfaSuite);
    describe('sessions', sessionsSuite);
    describe('active role', activeRoleSuite);
    describe('impersonation', impersonationSuite);
    describe('route table', routeTableSuite);
  });
});
