import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { fsHarness } from './support/fs-harness.js';

runBehaviour(['B28'], () => fsHarness(), { strict: true, timeoutMs: 30000 });
