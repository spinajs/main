import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { GLOBAL } from '@spinajs/authz';
import type { AuthzAdmin, AuthzService } from '@spinajs/authz';

import { rbacAdminHarness, rbacAdminStores } from './rbac-admin-harness.js';
import type { RbacAdminStores } from './rbac-admin-harness.js';

const expect = chai.expect;
const { ref, role, assignment } = fixtureDsl;

const NOW = new Date('2026-10-17T00:00:00.000Z');
const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const NODES = ['org', 'project'];

const olga = userPrincipal('olga');
const dave = userPrincipal('dave');
const erin = userPrincipal('erin');

const world: World = {
  now: NOW,
  permissions: ['project:read', 'project:settings', 'authz:assignments.manage'].map((name) => ({ name, types: NODES })),
  principals: { olga, dave, erin },
  scopes: [{ nodes: [{ ref: P1, parent: O1 }] }],
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('viewer', ['project:read'], { ladder: 'project' }), role('maintainer', ['project:settings'], { ladder: 'project' }), role('org.admin', ['authz:assignments.manage'], { ladder: 'org' })],
    ladders: [
      { name: 'project', roles: ['viewer', 'maintainer'], resourceTypes: ['project'] },
      { name: 'org', roles: ['org.admin'] },
    ],
    assignments: [assignment('olga-org', olga, 'org.admin', GLOBAL), assignment('olga-mt', olga, 'maintainer', P1)],
  },
};

describe('DefaultAdminGuard on the RbacModel: fresh covers checks', function () {
  this.timeout(30000);
  let stores: RbacAdminStores;
  const harness = rbacAdminHarness({ register: (host) => (stores = rbacAdminStores(host)) });
  let session: HarnessSession;

  before(async () => {
    await harness.beforeAll?.();
  });

  after(async () => {
    await harness.afterAll?.();
  });

  beforeEach(async () => {
    session = await harness.setup(world, { id: 'B26', part: 'guard', case: 'fresh', title: 'fresh', facets: ['engine', 'admin', 'rbac', 'ladders', 'cache'] });
  });

  afterEach(async () => {
    await session?.dispose();
  });

  it('an actor demoted on another node cannot grant the role it lost', async () => {
    const authz = session.authz as unknown as AuthzService;
    const admin = session.admin as AuthzAdmin;
    const grant = (to: typeof dave) => admin.execute(olga, [{ kind: 'assignment.grant', subject: { type: to.type, id: to.id }, role: 'maintainer', scope: P1 }]);
    expect((await grant(dave))[0].ok).to.equal(true);
    await authz.checkMany(olga, ['project:settings'], P1);

    // Another node's write: no change-bus event reaches this node's caches.
    stores.assignments['rows'].delete('olga-mt');

    const [r] = await grant(erin);
    if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
    expect(r.error.code).to.equal('escalation');
  });
});
