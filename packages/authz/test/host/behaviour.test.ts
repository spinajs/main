import 'mocha';

import { hostHarness, runBehaviour } from '@spinajs/authz-testing';
import type { BehaviourSelector } from '@spinajs/authz-testing';

// F4's own parts, then the core parts again as a parity check of the host against F3's engine harness.
const PARTS: readonly BehaviourSelector[] = ['B09.runAs', 'B27.bus', 'B27.domains', 'B27.cache', 'B29.host', 'B01.core', 'B02.core', 'B03.core', 'B04.core', 'B05.core', 'B06.core', 'B07.core', 'B08.core', 'B09.core', 'B14.core', 'B14.cache', 'B17.core', 'B22.core', 'B26.core', 'B36.core', 'B37.core', 'B39.core'];

runBehaviour(PARTS, hostHarness, { strict: true });
