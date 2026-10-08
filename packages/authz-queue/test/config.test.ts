import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA, AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { bindConfiguration, bootConfiguration, testHost, violationPaths } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA, AUTHZ_QUEUE_CONFIGURATION_SCHEMA, AuthzQueueConfigBootstrapper, AuthzQueueHook, AuthzQueueTrackingHook, QueueChangeBus, StampedInitiatorPrincipalFactory } from '../src/index.js';

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

  it('QueueChangeBus reads authz.bus.topic, none by default', async () => {
    expect(read(new QueueChangeBus(), await boot({ bus: { topic: '/topic/authz' } }), 'Topic')).to.equal('/topic/authz');
    expect(read(new QueueChangeBus(), await boot({}), 'Topic')).to.equal(undefined);
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
        const hook = bindConfiguration(new AuthzQueueHook(), child) as unknown as { service(): Promise<unknown> };
        const failure = await hook.service().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(failure, JSON.stringify(domain)).to.be.instanceOf(AuthzConfigError);
      }
    } finally {
      for (const c of children.splice(0)) await c.dispose();
      await testHost.uninstallHost();
    }
  });

  describe('authz.queue.stampedInitiatorWarning', () => {
    const warnings = async (factory: StampedInitiatorPrincipalFactory): Promise<number> => {
      const original = console.warn;
      let count = 0;
      console.warn = () => {
        count++;
      };
      try {
        await factory.principalOf({ type: 'user', id: 'u1' });
        await factory.principalOf({ type: 'user', id: 'u2' });
      } finally {
        console.warn = original;
      }
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

    it('the constructor option warn: false never reads the config', async () => {
      const throwing = bindConfiguration(new StampedInitiatorPrincipalFactory({ warn: false }), {
        get: () => {
          throw new Error('config was read');
        },
      } as unknown as IContainer);
      expect(await warnings(throwing)).to.equal(0);
      expect(await warnings(new StampedInitiatorPrincipalFactory({ warn: false }))).to.equal(0);
    });

    it('a new-built factory with no Configuration to read warns instead of throwing', async () => {
      const lonely = bindConfiguration(new StampedInitiatorPrincipalFactory(), DI.RootContainer.child());
      expect(await warnings(lonely)).to.equal(1);
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
