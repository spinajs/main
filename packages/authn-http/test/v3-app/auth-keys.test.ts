import 'mocha';

import { startApp, stopApp } from './app.js';
import { keyGateSuite } from './suites/keys.js';

// Sorts before behaviour/, whose harness loads authn-keys' DefaultKeyRegistry: no KeyRegistry is registered here. The
// routes over the real one run in behaviour/n8b.test.ts.
describe('3.0 key routes (N8b task 4)', function () {
  this.timeout(60000);

  before(startApp);
  after(stopApp);

  describe('without a KeyRegistry', keyGateSuite);
});
