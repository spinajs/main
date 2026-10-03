import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { queueHarness } from './support/queue-harness.js';

runBehaviour(['B09.queue', 'B27.queue', 'B30.queue'], queueHarness, { strict: true });
