import * as chai from 'chai';
import 'mocha';

import { requirePermitted } from '../../src/admin/permit.js';
// Not src/index.js: it would bring src/hooks.ts into a program that also holds the built package's declaration of the same actions.
import { TRUE } from '../../src/contracts/filter.js';
import type { AuthzService, CheckInput } from '../../src/contracts/service.js';
import type { Principal } from '../../src/contracts/principal.js';

const expect = chai.expect;

describe('AuthzAdmin permission checks', () => {
  it('run fresh, so a revoked admin role is not honoured from a cache', async () => {
    const seen: CheckInput[] = [];
    const authz = { check: async (input: CheckInput) => (seen.push(input), { allowed: true, residual: TRUE }) } as unknown as AuthzService;
    const actor = { type: 'user', id: 'root', authenticated: true, source: 'test', attributes: {} } as unknown as Principal;
    await requirePermitted(authz, actor, 'authz:assignments.manage', { type: 'org', id: 'o1' });
    expect(seen).to.have.length(1);
    expect(seen[0].fresh).to.equal(true);
  });
});
