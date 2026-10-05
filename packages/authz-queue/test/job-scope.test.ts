import 'mocha';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ConfigurationSource, JsFileSource } from '@spinajs/configuration';
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

describe('job:read grant', () => {
  it('is not in a config fragment that loads on install', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config');
    expect(existsSync(dir), 'every installed package config dir is read, imported or not').to.equal(false);
  });

  it('comes with the import as a configuration source', async () => {
    const { JobGrantSource } = await import('../src/job/job-grant.js');
    expect(DI.RootContainer.getRegisteredTypes(ConfigurationSource)).to.include(JobGrantSource);
    const cfg = await new JobGrantSource().Load();
    expect(cfg).to.deep.equal({ authz: { rbac: { roles: { user: { grants: [{ permission: 'job:read', relation: 'initiator' }] } } } } });
  });

  it('loads before the file sources, so the application can still override scalars', async () => {
    const { JobGrantSource } = await import('../src/job/job-grant.js');
    expect(new JobGrantSource().Order).to.be.lessThan(new JsFileSource().Order);
  });
});
