import 'mocha';
import { runBehaviour } from '@spinajs/authz-testing';

import { adminHarness } from './admin-harness.js';

// B43.attributes and B39.store run in the core, B43.policies and B27.policyEvents in authz-abac.
// B43.rules runs on DbRuleStore in test/integration/behaviour.db.test.ts.
runBehaviour(['B43.admin', 'B43.events', 'B26.guard', 'B27.events'], () => adminHarness(), { strict: true });
