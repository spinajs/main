import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '@spinajs/authz-testing';

import { B02Adapter } from './proposed/B02-adapter.js';
import { fsHarness } from './support/fs-harness.js';

// Cases L7 proposes to the kit (by RFC); until then they run from here.
runBehaviour(['B02.adapter'], () => fsHarness(), { strict: true, timeoutMs: 30000, fixtures: [...BEHAVIOUR_FIXTURES, B02Adapter] });
