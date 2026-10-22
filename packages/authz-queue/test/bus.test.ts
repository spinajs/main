import 'mocha';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, JsFileSource } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';
import type { AuthzChange } from '@spinajs/authz';

import { AuthzBusRouteSource, AuthzChangeEvent, reviveChange } from '../src/index.js';
import { MemoryBroker, MemoryQueueClient } from './support/memory-client.js';
import { NodeBus, PeerQueueService } from './support/nodes.js';

let seq = 0;

async function node(broker: string) {
  const client = new MemoryQueueClient({ name: `n${++seq}`, options: { broker } } as never);
  await client.resolve();
  const bus = new NodeBus(new PeerQueueService(client));
  const heard: AuthzChange[] = [];
  bus.subscribe((c) => heard.push(c));
  await bus.ready();
  return { client, bus, heard };
}

const change = (extra: Partial<AuthzChange> = {}): AuthzChange => ({ tags: ['subject:user:alice'], at: new Date('2030-01-02T03:04:05.000Z'), ...extra });

describe('QueueChangeBus', () => {
  let broker: string;
  let nodes: Awaited<ReturnType<typeof node>>[];

  beforeEach(() => {
    broker = `bus-${++seq}`;
    nodes = [];
  });

  afterEach(async () => {
    for (const n of nodes) {
      await n.bus.dispose();
      await n.client.dispose();
    }
    MemoryBroker.drop(broker);
  });

  const start = async () => {
    const n = await node(broker);
    nodes.push(n);
    return n;
  };

  it('a change published on one node reaches the subscribers of the others', async () => {
    const [a, b] = [await start(), await start()];

    await a.bus.publish(change({ domain: 'fs', actor: { type: 'user', id: 'alice' } }));

    expect(b.heard).to.have.length(1);
    expect(b.heard[0]).to.deep.equal({ domain: 'fs', tags: ['subject:user:alice'], actor: { type: 'user', id: 'alice' }, at: new Date('2030-01-02T03:04:05.000Z') });
  });

  it('the publishing node hears its own change once, before the broker round trip', async () => {
    const [a] = [await start(), await start()];

    await a.bus.publish(change());

    expect(a.heard).to.have.length(1);
  });

  it('an unsubscribed function hears nothing more', async () => {
    const [a, b] = [await start(), await start()];
    const extra: AuthzChange[] = [];
    const off = b.bus.subscribe((c) => extra.push(c));

    await a.bus.publish(change());
    off();
    await a.bus.publish(change());

    expect(extra).to.have.length(1);
    expect(b.heard).to.have.length(2);
  });

  it('a throwing subscriber does not stop the others', async () => {
    const [a, b] = [await start(), await start()];
    b.bus.subscribe(() => {
      throw new Error('boom');
    });
    const later: AuthzChange[] = [];
    b.bus.subscribe((c) => later.push(c));

    await a.bus.publish(change());

    expect(later).to.have.length(1);
  });

  it('a malformed change from the broker is dropped', async () => {
    const [a] = [await start()];

    for (const bad of [null, 'x', { tags: 'a' }, { tags: [1] }, { tags: [], domain: 3 }, { tags: [], actor: { type: 'user' } }]) {
      const event = new AuthzChangeEvent();
      event.Node = 'elsewhere';
      event.Change = bad as never;
      await a.client.emit(event as never);
    }

    expect(a.heard).to.have.length(0);
  });

  it('a change with more than 1000 tags, or a tag longer than 256 characters, reaches the other nodes as a change of every tag', async () => {
    const [a, b] = [await start(), await start()];
    const many = Array.from({ length: 1001 }, (_, i) => `t${i}`);

    await a.bus.publish(change({ tags: many }));
    await a.bus.publish(change({ tags: ['x'.repeat(257)] }));

    expect(a.heard.map((c) => c.tags.length)).to.deep.equal([1001, 1], 'the publishing node hears the change as made');
    expect(b.heard.map((c) => c.tags)).to.deep.equal([['*'], ['*']]);
  });

  it('a publish the queue refuses rejects, after the local subscribers heard it', async () => {
    const [a] = [await start()];
    a.client.emit = async () => {
      throw new Error('broker down');
    };

    await a.bus.publish(change()).then(
      () => expect.fail('should reject'),
      (e) => expect(e.message).to.equal('broker down'),
    );
    expect(a.heard).to.have.length(1);
  });
});

describe('AuthzBusRouteSource', () => {
  const ROUTE = ['queue', 'routing', 'AuthzChangeEvent'];

  /** The Configuration of a fresh child that loads `app` from a file-ordered source, then the route source, by Order. */
  async function boot(app: Record<string, unknown>) {
    const json = JSON.stringify(app);
    class AppSource extends ConfigurationSource {
      public get Order(): number {
        return new JsFileSource().Order;
      }
      public Load(): Promise<IConfigLike> {
        return Promise.resolve(JSON.parse(json) as IConfigLike);
      }
    }
    const child = DI.RootContainer.child();
    child
      .register(
        class RoutedConfiguration extends FrameworkConfiguration {
          protected loadSources(): void {
            this.Sources = [new AuthzBusRouteSource(), new AppSource()].sort((a, b) => a.Order - b.Order);
          }
        } as unknown as Class<Configuration>,
      )
      .as(Configuration);
    try {
      return { child, configuration: (await child.resolve(Configuration)) as Configuration };
    } catch (e) {
      await child.dispose();
      throw e;
    }
  }

  const load = (values: Record<string, unknown>) =>
    new AuthzBusRouteSource().Load({
      get: (path: string[]) => path.reduce<unknown>((v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), values),
    } as unknown as Configuration);

  it('comes with the import and loads after the file sources', () => {
    expect(DI.RootContainer.getRegisteredTypes(ConfigurationSource)).to.include(AuthzBusRouteSource);
    expect(new AuthzBusRouteSource().Order).to.be.greaterThan(new JsFileSource().Order);
  });

  it('routes the change events to authz.bus.topic, next to the routes of the app', async () => {
    const { child, configuration } = await boot({ authz: { bus: { topic: '/topic/authz' } }, queue: { routing: { Other: { channel: '/topic/other' } } } });
    try {
      expect(configuration.get(ROUTE)).to.deep.equal({ channel: '/topic/authz' });
      expect(configuration.get(['queue', 'routing', 'Other'])).to.deep.equal({ channel: '/topic/other' });
    } finally {
      await child.dispose();
    }
  });

  it('keeps the route the app gave', async () => {
    const { child, configuration } = await boot({ authz: { bus: { topic: '/topic/authz' } }, queue: { routing: { AuthzChangeEvent: { channel: '/topic/mine' } } } });
    try {
      expect(configuration.get(ROUTE)).to.deep.equal({ channel: '/topic/mine' });
    } finally {
      await child.dispose();
    }
  });

  it('adds nothing without a topic, or for one that is empty or not a string', async () => {
    const { child, configuration } = await boot({});
    try {
      expect(configuration.get(ROUTE)).to.equal(undefined);
    } finally {
      await child.dispose();
    }
    for (const topic of ['', 5, {}]) {
      expect(await load({ authz: { bus: { topic } } }), JSON.stringify(topic)).to.deep.equal({});
    }
  });
});

describe('reviveChange', () => {
  it('rebuilds a change that went through JSON', () => {
    const wire = JSON.parse(JSON.stringify({ domain: 'fs', tags: ['t'], actor: { type: 'user', id: 'a' }, at: new Date('2030-01-02T03:04:05.000Z') }));
    expect(reviveChange(wire)).to.deep.equal({ domain: 'fs', tags: ['t'], actor: { type: 'user', id: 'a' }, at: new Date('2030-01-02T03:04:05.000Z') });
  });

  it('refuses more than 1000 tags and a tag longer than 256 characters', () => {
    expect(reviveChange({ tags: Array.from({ length: 1000 }, () => 't'.repeat(256)) })?.tags).to.have.length(1000);
    expect(reviveChange({ tags: Array.from({ length: 1001 }, () => 't') })).to.equal(undefined);
    expect(reviveChange({ tags: ['t'.repeat(257)] })).to.equal(undefined);
  });

  it('keeps a change without optional fields minimal and dates it now when `at` is unusable', () => {
    const c = reviveChange({ tags: [], at: 'never' })!;
    expect(Object.keys(c).sort()).to.deep.equal(['at', 'tags']);
    expect(c.at).to.be.instanceOf(Date);
    expect(Number.isNaN(c.at.getTime())).to.equal(false);
  });
});
