import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { ConfigRuleStore } from '../../src/index.js';
import { rbacHarness } from '../model/harness.js';

const harness = () => rbacHarness({ facets: ['ladders', 'rules', 'conditions', 'links'], rules: (host) => new ConfigRuleStore(host.world.rbac?.rules ?? []) });

runBehaviour(['B38.rbac', 'B42.rbac', 'B46.links'], harness, { strict: true, timeoutMs: 30_000 });
