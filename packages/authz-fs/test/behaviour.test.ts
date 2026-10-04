import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { fsHarness } from './support/fs-harness.js';

runBehaviour(['B28', 'B29.fs'], () => fsHarness(), { strict: true, timeoutMs: 30000 });
