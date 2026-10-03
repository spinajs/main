import 'mocha';
import { runBehaviour } from '@spinajs/authz-testing';

import { adminHarness } from './admin-harness.js';

// B43.attributes and B39.store run in the core, B43.policies and B27.policyEvents in authz-abac.
// B43.rules waits on L2: its "DB rule outside SQL form" case needs DbRuleStore and toSqlForm.
runBehaviour(['B43.admin', 'B43.events', 'B26.guard', 'B27.events'], () => adminHarness(), { strict: true });
