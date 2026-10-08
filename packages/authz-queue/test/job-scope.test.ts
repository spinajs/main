import 'mocha';

import { expect } from 'chai';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, SetupContext, World } from '@spinajs/authz-testing';
import { AccessDenied, SYSTEM, UNATTENDED } from '@spinajs/authz';
import { JobModel } from '@spinajs/queue';

import { queueHarness } from './support/queue-harness.js';

const { combine, permit, relation, staticModel } = fixtureDsl;
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');

const world: World = {
  permissions: [],
  principals: { alice, bob },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.permission === 'job:read' ? permit(relation('initiator')) : {}) })],
  lane: { queue: { jobs: [{ name: 'plain' }, { name: 'progress' }] } },
};

describe('JobModel as an access resource', () => {
  const harness = queueHarness();
  let session: HarnessSession;

  before(() => harness.beforeAll?.());
  after(() => harness.afterAll?.());
  beforeEach(async () => {
    session = await harness.setup(world, { id: 'B30', part: 'queue', case: 'job-scope', title: 'job-scope', facets: ['engine', 'host', 'queue'] } as SetupContext);
  });
  afterEach(() => session.dispose());

  const emitAs = async (who: typeof alice, job: string) => {
    const authz = session.authz as unknown as import('@spinajs/authz').AuthzService;
    const message = await authz.runAs(who, 'test', () => session.lane!.queue!.emit(job));
    await session.lane!.queue!.handle(message);
    return message as unknown as { JobId: string };
  };

  it('the consumer tracks an unattended job although the table is scoped', async () => {
    const m = await emitAs(alice, 'plain');
    const authz = session.authz as unknown as import('@spinajs/authz').AuthzService;
    const row = await authz.runAs(SYSTEM, 'test', () => JobModel.where({ JobId: m.JobId }).first());
    expect(row?.Status).to.equal('success');
    expect(row?.InitiatorId).to.equal('alice');
  });

  it('a query without a principal on JobModel is refused', async () => {
    const authz = session.authz as unknown as import('@spinajs/authz').AuthzService;
    await authz.runAs(UNATTENDED, 'test', async () => {
      await JobModel.all().then(
        () => expect.fail('should be denied'),
        (e) => expect(e).to.be.instanceOf(AccessDenied),
      );
    });
  });

  it('a user reads the jobs they emitted and no others', async () => {
    const a = await emitAs(alice, 'plain');
    const b = await emitAs(bob, 'plain');
    const authz = session.authz as unknown as import('@spinajs/authz').AuthzService;
    const ids = await authz.runAs(alice, 'test', async () => (await JobModel.all()).map((r) => r.JobId));
    expect(ids).to.deep.equal([a.JobId]);
    expect(ids).to.not.include(b.JobId);
  });
});

describe('queue config fragment', () => {
  it('grants job:read with relation initiator to the user role', async () => {
    const fragment = (await import('../src/config/queue.js')).default;
    expect(fragment.authz.rbac.roles.user.grants).to.deep.equal([{ permission: 'job:read', relation: 'initiator' }]);
  });
});
