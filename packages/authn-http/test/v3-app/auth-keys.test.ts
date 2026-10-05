import 'mocha';

import { keyGateSuite } from './suites/keys.js';

// The routes over the real KeyRegistry run in behaviour/n8b.test.ts; with and without authn-keys in
// test/v3/route-groups-boot.test.ts.
describe('3.0 key routes (N8b task 4)', function () {
  describe('the KeyRegistry gate', keyGateSuite);
});
