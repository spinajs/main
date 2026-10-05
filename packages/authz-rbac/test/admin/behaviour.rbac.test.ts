import 'mocha';
import { runBehaviour } from '@spinajs/authz-testing';

import { rbacAdminHarness } from './rbac-admin-harness.js';

runBehaviour(['B26.guard', 'B38.admin'], () => rbacAdminHarness(), { strict: true, timeoutMs: 30_000 });
