import 'mocha';

import { startApp, stopApp } from './app.js';
import { tokenGateSuite } from './suites/tokens.js';

// Sorts before behaviour/, whose harness loads authn-token's DbTokenService: no TokenService is registered here. The
// routes over the real one run in behaviour/n8b.test.ts.
describe('3.0 token routes (N8b task 3)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('without a TokenService', tokenGateSuite);
});
