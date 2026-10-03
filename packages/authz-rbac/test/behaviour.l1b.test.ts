import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { rbacHarness } from './model/harness.js';

runBehaviour(['B05.ladders'], () => rbacHarness({ facets: ['ladders'] }), { strict: true, timeoutMs: 30_000 });
