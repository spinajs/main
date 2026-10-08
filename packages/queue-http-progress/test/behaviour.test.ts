import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { statusHarness } from './support/status-harness.js';

runBehaviour(['B30.status'], statusHarness, { strict: true });
