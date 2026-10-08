import 'mocha';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, JsFileSource, registerConfigurationSchema } from '@spinajs/configuration';
import { fixtureDsl, userPrincipal, violationPaths } from '@spinajs/authz-testing';
import { AUTHZ_RBAC_CONFIGURATION_SCHEMA } from '@spinajs/authz-rbac';
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

  describe('merged into the application configuration', () => {
    const grant = { permission: 'job:read', relation: 'initiator' };

    async function bootWith(app: Record<string, unknown>) {
      const { JobGrantSource } = await import('../src/job/job-grant.js');
      const child = DI.RootContainer.child();
      child
        .register(
          class GrantedConfiguration extends FrameworkConfiguration {
            protected loadSources(): void {
              this.Sources = [new JobGrantSource()];
            }

            protected onLoad(): unknown {
              return app;
            }
          } as unknown as Class<Configuration>,
        )
        .as(Configuration);
      registerConfigurationSchema(AUTHZ_RBAC_CONFIGURATION_SCHEMA, child);
      try {
        return { child, configuration: (await child.resolve(Configuration)) as Configuration };
      } catch (e) {
        await child.dispose();
        throw e;
      }
    }

    it('passes the authz-rbac schema without an application value', async () => {
      const { child, configuration } = await bootWith({});
      try {
        expect(configuration.get('authz.rbac.roles.user.grants')).to.deep.equal([grant]);
      } finally {
        await child.dispose();
      }
    });

    it('concatenates with the grants of the application', async () => {
      const own = { permission: 'report:read' };
      const { child, configuration } = await bootWith({ authz: { rbac: { roles: { user: { grants: [own] } } } } });
      try {
        expect(configuration.get('authz.rbac.roles.user.grants')).to.deep.equal([grant, own]);
      } finally {
        await child.dispose();
      }
    });

    it('is still checked: a bad application grant fails the boot with its path', async () => {
      const bad = bootWith({ authz: { rbac: { roles: { user: { grants: [{ permission: {} }] } } } } });
      expect((await violationPaths(bad)).some((p) => p.startsWith('authz.rbac.roles.user.grants'))).to.equal(true);
    });
  });

  it('loads before the file sources, so the application can still override scalars', async () => {
    const { JobGrantSource } = await import('../src/job/job-grant.js');
    expect(new JobGrantSource().Order).to.be.lessThan(new JsFileSource().Order);
  });
});
