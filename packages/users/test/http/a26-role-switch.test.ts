import 'mocha';
import { runAuthnBehaviour } from '@spinajs/authn-testing';

import { usersAuthnHarness } from '../support/authn-harness.js';
import { registerRootRbac, startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';

describe('A26 role switch over http on users RbacRoleSource (C3b)', function () {
  before(async function () {
    this.timeout(120000);
    await startUsersHttpApp({ register: registerRootRbac });
  });

  after(async function () {
    this.timeout(60000);
    await stopUsersHttpApp();
  });

  runAuthnBehaviour(['A26'], usersAuthnHarness, { title: 'users: A26/http', claim: ['A26/http'], facets: ['A26/http'], timeoutMs: 30000 });
});
