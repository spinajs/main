import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '@spinajs/authz-testing';

import { B16Owner } from './proposed/B16-owner.js';
import { fsHarness } from './support/fs-harness.js';

// The fs grants of design §8.2 through the real RbacModel: the kit's B16.fs and the owner grant B16.fs left to L7.
runBehaviour(['B16.fs', 'B16.fs-owner'], () => fsHarness({ rbac: true }), { strict: true, timeoutMs: 30000, fixtures: [...BEHAVIOUR_FIXTURES, B16Owner] });
