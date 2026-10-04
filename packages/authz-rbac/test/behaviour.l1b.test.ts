import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { rbacHarness } from './model/harness.js';

runBehaviour(['B05.ladders', 'B12.implies', 'B31.ladders', 'B32.ladders', 'B33', 'B34'], () => rbacHarness({ facets: ['ladders'] }), { strict: true, timeoutMs: 30_000 });
