import 'mocha';
import { runBehaviour } from '@spinajs/authz-testing';

import { rbacAdminHarness } from './rbac-admin-harness.js';

runBehaviour(['B26.guard', 'B38.admin', 'B38.rbac'], () => rbacAdminHarness(), { strict: true, timeoutMs: 30_000 });

// Facet `store` stands for L2's DB stores; here it only gives B38.store the MemoryLinkStore's rows.
runBehaviour(['B38.store'], () => rbacAdminHarness({ facets: ['store'] }), { strict: true, timeoutMs: 30_000 });
