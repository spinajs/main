import 'mocha';

import { expect } from 'chai';
import { fixtureDsl, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, SetupContext, World } from '@spinajs/authz-testing';

import { statusHarness } from './support/status-harness.js';

const { assignment, combine, role } = fixtureDsl;
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');

type Grant = { readonly permission: string; readonly relation?: string };

describe('GET jobs/v1/:jobId/status under the job:read grant of @spinajs/authz-queue/jobs', () => {
  const harness = statusHarness({ rbac: true });
  let session: HarnessSession;
  let userGrants: Grant[];

  before(async () => {
    await harness.beforeAll?.();
    // startApp seeded the configuration from every source, so this is the user role an app that imports the subpath gets.
    userGrants = testHost.config().get<Grant[]>(['authz', 'rbac', 'roles', 'user', 'grants']) ?? [];
  });
  after(() => harness.afterAll?.());
  beforeEach(async () => {
    // Only the job grants: the user role of the installed packages also grants user:* permissions this test domain does not register.
    const world: World = {
      permissions: [],
      principals: { alice, bob },
      combine: combine('deny-overrides', 'rbac'),
      rbac: {
        roles: [role('user', userGrants.filter((g) => g.permission.startsWith('job:')))],
        assignments: [assignment('a1', alice, 'user'), assignment('a2', bob, 'user')],
      },
      lane: { queue: { records: [{ id: 'j1', job: 'export', initiator: { type: 'user', id: 'alice' }, status: 'success' }] } },
      // The installed packages' authz.rbac (service roles of roles this world does not define) would fail the model's init.
      config: { rbac: {} },
    };
    session = await harness.setup(world, { id: 'B30', part: 'status', case: 'job-grant', title: 'job-grant', facets: ['engine', 'http', 'queue'] } as SetupContext);
  });
  afterEach(() => session?.dispose());

  const get = (who: typeof alice) => session.lane!.http!.request({ method: 'GET', path: '/jobs/v1/j1/status', principal: who });

  it('the user role holds job:read on owner', () => {
    expect(userGrants).to.deep.include({ permission: 'job:read', relation: 'owner' });
  });

  it('answers the job initiator 200 and another user 404', async () => {
    const own = await get(alice);
    expect(own.status).to.equal(200);
    expect((own.body as { jobId?: string }).jobId).to.equal('j1');
    expect((await get(bob)).status).to.equal(404);
  });
});
