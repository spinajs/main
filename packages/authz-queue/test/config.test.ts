import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA, AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { bindConfiguration, bootConfiguration, testHost, violationPaths } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA, AUTHZ_QUEUE_CONFIGURATION_SCHEMA, AuthzQueueConfigBootstrapper, AuthzQueueHook, QueueChangeBus, StampedInitiatorPrincipalFactory } from '../src/index.js';
import { AuthzQueueTrackingHook } from '../src/job/index.js';

describe('authz-queue configuration through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_QUEUE_CONFIGURATION_SCHEMA, AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const read = (instance: object, child: IContainer, key: string): unknown => (bindConfiguration(instance, child) as unknown as Record<string, unknown>)[key];

  it('the hooks read authz.queue.domain of their container, root by default', async () => {
    const tenant = await boot({ queue: { domain: 'tenant' } });
    expect(read(new AuthzQueueHook(), tenant, 'Domain')).to.equal('tenant');
    expect(read(new AuthzQueueTrackingHook(), tenant, 'Domain')).to.equal('tenant');
    expect(read(new AuthzQueueTrackingHook(), await boot({}), 'Domain')).to.equal('root');
  });

  it('refuses an empty domain or topic at boot', async () => {
    expect(await violationPaths(boot({ queue: { domain: '' } }))).to.include('authz.queue.domain');
    expect(await violationPaths(boot({ bus: { topic: '' } }))).to.include('authz.bus.topic');
  });

  it('a domain set at runtime to no live domain fails the hooks closed, never falls back to root', async () => {
    await testHost.installHost();
    try {
      for (const domain of ['', 'nowhere']) {
        const child = await boot({});
        (await child.resolve(Configuration)).set(['authz', 'queue', 'domain'], domain);
        // DI caches the hook in root; a fresh one reads this child's domain.
        DI.uncache(AuthzQueueHook);
        const hook = (await child.resolve(AuthzQueueHook)) as unknown as { service(): Promise<unknown> };
        const failure = await hook.service().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(failure, JSON.stringify(domain)).to.be.instanceOf(AuthzConfigError);
      }
    } finally {
      DI.uncache(AuthzQueueHook);
      for (const c of children.splice(0)) await c.dispose();
      await testHost.uninstallHost();
    }
  });

  describe('authz.queue.stampedInitiatorWarning', () => {
    const warnings = async (factory: StampedInitiatorPrincipalFactory): Promise<number> => {
      let count = 0;
      (factory as unknown as { Log: unknown }).Log = {
        warn: () => {
          count++;
        },
      };
      await factory.principalOf({ type: 'user', id: 'u1' });
      await factory.principalOf({ type: 'user', id: 'u2' });
      return count;
    };

    it('defaults to true: warns once', async () => {
      const child = await boot({});
      expect((await child.resolve(Configuration)).get('authz.queue.stampedInitiatorWarning')).to.equal(true);
      expect(await warnings(bindConfiguration(new StampedInitiatorPrincipalFactory(), child))).to.equal(1);
    });

    it('false in config: never warns', async () => {
      const child = await boot({ queue: { stampedInitiatorWarning: false } });
      expect(await warnings(bindConfiguration(new StampedInitiatorPrincipalFactory(), child))).to.equal(0);
    });

    it('is read per container, at the first principal', async () => {
      const quiet = await boot({ queue: { stampedInitiatorWarning: false } });
      const loud = await boot({});
      expect(await warnings(bindConfiguration(new StampedInitiatorPrincipalFactory(), quiet))).to.equal(0);
      expect(await warnings(bindConfiguration(new StampedInitiatorPrincipalFactory(), loud))).to.equal(1);
    });

    it('a value the schema never saw keeps the warning', async () => {
      const child = await boot({});
      (await child.resolve(Configuration)).set(['authz', 'queue', 'stampedInitiatorWarning'], 'no');
      expect(await warnings(bindConfiguration(new StampedInitiatorPrincipalFactory(), child))).to.equal(1);
    });

    it('the constructor option warn decides without reading the config', async () => {
      const throwing = { get: () => expect.fail('config was read') } as unknown as IContainer;
      expect(await warnings(bindConfiguration(new StampedInitiatorPrincipalFactory({ warn: false }), throwing))).to.equal(0);
      expect(await warnings(bindConfiguration(new StampedInitiatorPrincipalFactory({ warn: true }), throwing))).to.equal(1);
      expect(await warnings(new StampedInitiatorPrincipalFactory({ warn: false }))).to.equal(0);
    });

    it('a new-built factory without the option and with no Configuration to read throws', async () => {
      const lonely = bindConfiguration(new StampedInitiatorPrincipalFactory(), DI.RootContainer.child());
      const failure = await lonely.principalOf({ type: 'user', id: 'u1' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(failure).to.be.instanceOf(InvalidOperation);
    });

    it('refuses a non-boolean at boot', async () => {
      expect(await violationPaths(boot({ queue: { stampedInitiatorWarning: {} } }))).to.include('authz.queue.stampedInitiatorWarning');
    });
  });

  it('the bootstrapper registers both schemas', () => {
    const KEY = '__configurationSchema__';
    const had = DI.RootContainer.Cache.has(KEY);
    new AuthzQueueConfigBootstrapper().bootstrap();
    try {
      expect(DI.RootContainer.Cache.get(KEY)).to.include.members([AUTHZ_QUEUE_CONFIGURATION_SCHEMA, AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA]);
    } finally {
      const list = DI.RootContainer.Cache.get(KEY) as unknown[];
      for (const schema of [AUTHZ_QUEUE_CONFIGURATION_SCHEMA, AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA]) list.splice(list.indexOf(schema), 1);
      if (!had && list.length === 0) DI.uncache(KEY);
    }
  });
});
