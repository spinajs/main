import 'mocha';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { AuthzChange } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

import { AuthzChangeEvent, reviveChange } from '../src/index.js';
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

  describe('route', () => {
    it('routes the change events to authz.bus.topic unless the app routed them', async () => {
      await testHost.installHost();
      try {
        const cfg = DI.get(Configuration)!;
        cfg.set(['authz', 'bus', 'topic'], '/topic/authz');
        cfg.set(['queue', 'routing'], {});
        const n = await start();
        await n.bus.publish(change());
        expect(cfg.get(['queue', 'routing', 'AuthzChangeEvent'])).to.deep.equal({ channel: '/topic/authz' });

        cfg.set(['queue', 'routing', 'AuthzChangeEvent'], { channel: '/topic/mine' });
        const m = await start();
        await m.bus.publish(change());
        expect(cfg.get(['queue', 'routing', 'AuthzChangeEvent'])).to.deep.equal({ channel: '/topic/mine' });
      } finally {
        await testHost.uninstallHost();
      }
    });

    it('never routes to a topic set at runtime that is empty or not a string', async () => {
      await testHost.installHost();
      try {
        const cfg = DI.get(Configuration)!;
        for (const topic of ['', 5, {}]) {
          cfg.set(['authz', 'bus', 'topic'], topic);
          cfg.set(['queue', 'routing'], {});
          const n = await start();
          await n.bus.publish(change());
          expect(cfg.get(['queue', 'routing', 'AuthzChangeEvent']), JSON.stringify(topic)).to.equal(undefined);
        }
      } finally {
        await testHost.uninstallHost();
      }
    });
  });
});

describe('reviveChange', () => {
  it('rebuilds a change that went through JSON', () => {
    const wire = JSON.parse(JSON.stringify({ domain: 'fs', tags: ['t'], actor: { type: 'user', id: 'a' }, at: new Date('2030-01-02T03:04:05.000Z') }));
    expect(reviveChange(wire)).to.deep.equal({ domain: 'fs', tags: ['t'], actor: { type: 'user', id: 'a' }, at: new Date('2030-01-02T03:04:05.000Z') });
  });

  it('keeps a change without optional fields minimal and dates it now when `at` is unusable', () => {
    const c = reviveChange({ tags: [], at: 'never' })!;
    expect(Object.keys(c).sort()).to.deep.equal(['at', 'tags']);
    expect(c.at).to.be.instanceOf(Date);
    expect(Number.isNaN(c.at.getTime())).to.equal(false);
  });
});
