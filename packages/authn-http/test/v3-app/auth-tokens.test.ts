import 'mocha';

import { tokenGateSuite } from './suites/tokens.js';

// The routes over the real TokenService run in behaviour/n8b.test.ts; with and without authn-token in
// test/v3/route-groups-boot.test.ts.
describe('3.0 token routes (N8b task 3)', function () {
  describe('the TokenService gate', tokenGateSuite);
});
