import 'mocha';

import { expect } from 'chai';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, SetupContext, World } from '@spinajs/authz-testing';

import { statusHarness } from './support/status-harness.js';

const { combine, permit, relation, staticModel } = fixtureDsl;
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');

const world: World = {
  permissions: [],
  principals: { alice, bob, carol },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.permission !== 'job:read' ? {} : req.principal.id === 'carol' ? permit() : permit(relation('initiator'))) })],
  lane: {
    queue: {
      records: [
        { id: 'j1', job: 'export', initiator: { type: 'user', id: 'alice' }, status: 'success' },
        { id: 'j2', job: 'export', initiator: { type: 'user', id: 'bob' }, status: 'executing' },
      ],
    },
  },
};

describe('GET jobs/v1/:jobId/status', () => {
  const harness = statusHarness();
  let session: HarnessSession;

  before(() => harness.beforeAll?.());
  after(() => harness.afterAll?.());
  beforeEach(async () => {
    session = await harness.setup(world, { id: 'B30', part: 'status', case: 'status-route', title: 'status-route', facets: ['engine', 'http', 'queue'] } as SetupContext);
  });
  afterEach(() => session.dispose());

  const get = (jobId: string, who?: typeof alice) => session.lane!.http!.request({ method: 'GET', path: `/jobs/v1/${jobId}/status`, ...(who ? { principal: who } : {}) });

  it('answers another user and an unknown job identically', async () => {
    const denied = await get('j2', alice);
    const unknown = await get('nope', alice);
    expect(denied.status).to.equal(404);
    // Only the echoed id may differ.
    const shape = (r: { status: number; body: unknown }, id: string) => JSON.parse(JSON.stringify(r).split(id).join('<id>'));
    expect(shape(unknown, 'nope')).to.deep.equal(shape(denied, 'j2'));
  });

  it('answers the owner of each job', async () => {
    expect((await get('j1', alice)).status).to.equal(200);
    expect((await get('j2', bob)).status).to.equal(200);
  });

  it('lets an unconditional holder read any job and gets 404 for an unknown one', async () => {
    expect((await get('j2', carol)).status).to.equal(200);
    expect((await get('nope', carol)).status).to.equal(404);
  });

  it('refuses a request without a principal', async () => {
    expect((await get('j1')).status).to.equal(401);
  });
});
