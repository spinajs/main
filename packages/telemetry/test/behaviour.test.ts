import 'mocha';
import { runBehaviour } from '@spinajs/authz-testing';

import { telemetryHarness } from './support/telemetry-harness.js';

runBehaviour(['B23.configNamed'], () => telemetryHarness(), { strict: true });
