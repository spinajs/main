import 'mocha';
import { runBehaviour } from '@spinajs/authz-testing';

import { adminHttpHarness } from './support/admin-http.js';

// The first hook boots the app and loads authz-rbac's src through ts-node, which takes more than mocha's 2 s.
// B38.admin and B38.adminHttp resolve tokens through the test rbacLinks over MemoryLinkStore; switch to L1b's LinkResolver once it merges.
describe('authz-http-admin behaviour', function () {
  this.timeout(30000);
  runBehaviour(['B43.http', 'B12.http', 'B13.http', 'B26.http', 'B27.events', 'B38.adminHttp', 'B38.admin'], () => adminHttpHarness(), { strict: true });
});
