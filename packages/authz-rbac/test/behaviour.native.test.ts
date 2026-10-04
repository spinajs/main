import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { rbacAssignmentExtension } from '../src/index.js';
import { rbacHarness } from './model/harness.js';

// RFC L1-2: the adapters of the kit's RBAC worlds compile native:rbac.assignment, so its parts also hold with the native term.
describe('RBAC parts with rbacAssignmentExtension (RFC L1-2)', () => {
  runBehaviour(['B01.rbac', 'B02.rbac', 'B05.rbac', 'B06.rbac', 'B07.rbac', 'B11.rbac', 'B12.rbac', 'B13.rbac', 'B14.rbac', 'B15.rbac', 'B16.rbac', 'B17.rbac', 'B22.rbac'], () => rbacHarness({ extensions: (_host, options) => [rbacAssignmentExtension(options)] }), { strict: true, timeoutMs: 30_000 });
});
