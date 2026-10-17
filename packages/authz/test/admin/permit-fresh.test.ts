import * as chai from 'chai';
import 'mocha';

import { requirePermitted } from '../../src/admin/permit.js';
import { TRUE } from '../../src/index.js';
import type { AuthzService, CheckInput, Principal } from '../../src/index.js';

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
