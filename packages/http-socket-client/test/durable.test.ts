import 'mocha';
import { expect } from 'chai';
import type { CommandRequest, SocketError } from '@spinajs/http-socket-common';
import { CommandDispatcher } from '../src/commands.js';
import { DEFAULT_DURABLE, DurableQueue, type AckedCommand, type FailedCommand } from '../src/durable.js';
import { MemoryOutboxStore, type OutboxInput, type OutboxStore } from '../src/outbox.js';
import { closeAll, track } from './support/cleanup.js';
import { rejectionOf } from './support/commands.js';
import { FAST_RECONNECT, makeConnection } from './support/connection.js';
import { onlineQueue, serveDurable } from './support/durable.js';
import { StubServer } from './support/stub-server.js';
import { nextEmit, sleep, until } from './support/wait.js';

describe('DurableQueue', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  const fresh = (store: OutboxStore = new MemoryOutboxStore()) => {
    const connection = makeConnection(server);
    const queue = track(new DurableQueue({ connection, commands: new CommandDispatcher(connection, 1000), store, clientId: 'client-1', reconnect: FAST_RECONNECT }));
    return { connection, queue };
  };

  it('ships the spec defaults', () => {
    expect(DEFAULT_DURABLE).to.deep.equal({ window: 16, ackTimeoutMs: 60_000 });
  });

  it('sends in order, keyed clientId:seq, each after the previous unacknowledged command, without a deadline', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 100 };
    const { queue } = await onlineQueue(server);

    const results = await Promise.all([1, 2, 3].map((n) => queue.submit('docs.submit', { n })));

    expect(results).to.deep.equal([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(server.requests.map((r) => [r.idempotencyKey, r.after])).to.deep.equal([
      ['client-1:1', undefined],
      ['client-1:2', 'client-1:1'],
      ['client-1:3', 'client-1:2'],
    ]);
    expect(server.requests.every((r) => r.deadline === undefined)).to.be.true;
  });

  it('keeps at most window commands unanswered', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 200 };
    const { queue } = await onlineQueue(server, { durable: { window: 3 } });

    const all = Promise.all(Array.from({ length: 7 }, (_, n) => queue.submit('docs.submit', { n })));
    await sleep(100);
    expect(server.requests).to.have.length(3);

    await all;
    expect(server.requests).to.have.length(7);
  });

  it('writes a command to the store before it sends it', async () => {
    serveDurable(server, 'docs.submit');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const store = new MemoryOutboxStore();
    const add = store.add.bind(store);
    store.add = (async (input: OutboxInput) => {
      await gate;
      return add(input);
    }) as OutboxStore['add'];
    const { queue } = await onlineQueue(server, { store });

    const done = queue.submit('docs.submit', { n: 1 });
    await sleep(100);
    expect(server.requests).to.have.length(0);

    release();
    expect(await done).to.deep.equal({ n: 1 });
    await sleep(20);
    expect(await store.pending()).to.deep.equal([]);
  });

  it('resends what was not acknowledged after a drop; each command runs once and settles in order', async () => {
    const stub = serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 150 };
    const { queue } = await onlineQueue(server);
    const settled: number[] = [];

    const all = Promise.all([1, 2, 3, 4].map((n) => queue.submit('docs.submit', { n }).then(() => settled.push(n))));
    await until(() => stub.runs.size === 4);
    // the four replies are still delayed: they die with the transport
    server.killConnections();
    server.ackFault = { kind: 'none' };
    await all;

    expect(settled).to.deep.equal([1, 2, 3, 4]);
    expect([...stub.runs.values()]).to.deep.equal([1, 1, 1, 1]);
    expect(server.requests.length).to.be.above(4);
  });

  it('runs each of 500 commands once and settles them in order while the connection is killed 10 times', async () => {
    const stub = serveDurable(server, 'docs.submit');
    // each kill follows fresh runs, so their delayed replies die with the transport
    server.ackFault = { kind: 'delay', ms: 30 };
    const { queue } = await onlineQueue(server);
    const settled: number[] = [];

    const all = Promise.all(Array.from({ length: 500 }, (_, n) => queue.submit('docs.submit', { n }).then(() => settled.push(n))));
    for (let kill = 0; kill < 10; kill++) {
      const ran = stub.order.length;
      await until(() => stub.order.length >= ran + 20, 10_000, 1);
      server.killConnections();
    }
    await all;

    expect(settled).to.deep.equal(Array.from({ length: 500 }, (_, n) => n));
    expect(stub.order).to.deep.equal(Array.from({ length: 500 }, (_, n) => `client-1:${n + 1}`));
    expect([...stub.runs.values()].every((runs) => runs === 1)).to.be.true;
    expect(server.requests.length).to.be.above(500);
  }).timeout(20_000);

  it('retries a retryable refusal after a backoff that honours retryAfterMs', async () => {
    let refusals = 2;
    serveDurable(server, 'docs.submit', (payload) => {
      if (refusals-- > 0) {
        throw { code: 'resource_exhausted', message: 'busy', retryable: true, retryAfterMs: 30 } as SocketError;
      }
      return payload;
    });
    const { queue } = await onlineQueue(server);
    const started = Date.now();

    expect(await queue.submit('docs.submit', { n: 1 })).to.deep.equal({ n: 1 });
    expect(server.requests).to.have.length(3);
    expect(Date.now() - started).to.be.at.least(60);
  });

  it('moves a command refused for good to the failed list, emits failed, and goes on with the next one', async () => {
    serveDurable(server, 'docs.submit', (payload: { n: number }) => {
      if (payload.n === 2) {
        throw { code: 'invalid_argument', message: 'malformed op', retryable: false } as SocketError;
      }
      return payload;
    });
    const store = new MemoryOutboxStore();
    const { queue } = await onlineQueue(server, { store });
    const failed: FailedCommand[] = [];
    queue.events.on('failed', (event) => failed.push(event));

    const [one, two, three] = [1, 2, 3].map((n) => queue.submit('docs.submit', { n }));
    const error = await rejectionOf(two);

    expect(await one).to.deep.equal({ n: 1 });
    expect(await three).to.deep.equal({ n: 3 });
    expect(error.code).to.equal('invalid_argument');
    expect(failed).to.have.length(1);
    expect(failed[0].entry).to.include({ seq: 2, name: 'docs.submit' });
    expect(failed[0].error.code).to.equal('invalid_argument');
    await sleep(20);
    expect((await store.failed()).map((e) => e.seq)).to.deep.equal([2]);
    expect(await store.pending()).to.deep.equal([]);
  });

  it('keeps a command whose credentials ran out queued instead of failing it', async () => {
    let expired = true;
    const stub = serveDurable(server, 'docs.submit', undefined, { refuse: () => (expired ? { code: 'unauthenticated', message: 'credentials expired', retryable: false } : undefined) });
    const { queue } = await onlineQueue(server);
    const failed: FailedCommand[] = [];
    queue.events.on('failed', (event) => failed.push(event));

    const done = queue.submit('docs.submit', { n: 1 });
    await until(() => server.requests.length >= 1);
    await sleep(50);
    expired = false;

    expect(await done).to.deep.equal({ n: 1 });
    expect(failed).to.deep.equal([]);
    expect(stub.runs.get('client-1:1')).to.equal(1);
  });

  it('resumes the entries a previous queue left in the store and reports them through acked', async () => {
    const stub = serveDurable(server, 'docs.submit');
    const store = new MemoryOutboxStore();
    await store.add({ name: 'docs.submit', payload: { n: 1 } });
    await store.add({ name: 'docs.submit', payload: { n: 2 }, key: 'op-2' });
    const acked: AckedCommand[] = [];

    const { connection, queue } = fresh(store);
    queue.events.on('acked', (event) => acked.push(event));
    connection.connect();
    await until(() => acked.length === 2);

    expect(acked.map((a) => [a.entry.seq, a.result])).to.deep.equal([
      [1, { n: 1 }],
      [2, { n: 2 }],
    ]);
    expect(stub.order).to.deep.equal(['client-1:1', 'op-2']);
    expect(server.requests[1].after).to.equal('client-1:1');
    await sleep(20);
    expect(await store.pending()).to.deep.equal([]);
  });

  it('rejects waiting callers on close but keeps their entries in the store', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'drop' };
    const { queue, store } = await onlineQueue(server);

    const done = queue.submit('docs.submit', { n: 1 });
    await until(() => server.requests.length === 1);
    queue.close();
    const error = await rejectionOf(done);

    expect(error.code).to.equal('unavailable');
    expect(error.retryable).to.be.false;
    expect((await store.pending()).map((e) => e.seq)).to.deep.equal([1]);
    expect((await rejectionOf(queue.submit('docs.submit', {}))).code).to.equal('unavailable');
  });

  it('sends a command again when its reply does not come within ackTimeoutMs', async () => {
    const stub = serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'drop' };
    const { queue } = await onlineQueue(server, { durable: { ackTimeoutMs: 150 } });

    const done = queue.submit('docs.submit', { n: 1 });
    await until(() => server.requests.length === 1);
    server.ackFault = { kind: 'none' };

    expect(await done).to.deep.equal({ n: 1 });
    expect(server.requests).to.have.length(2);
    expect(stub.runs.get('client-1:1')).to.equal(1);
  });

  it('uses an app key verbatim and refuses one the server would refuse', async () => {
    serveDurable(server, 'docs.submit');
    const { queue } = await onlineQueue(server);

    await queue.submit('docs.submit', { n: 1 }, { key: 'op-1' });
    expect(server.requests[0].idempotencyKey).to.equal('op-1');

    for (const key of ['', 'a b', 'k'.repeat(257)]) {
      const error = await queue.submit('docs.submit', {}, { key }).catch((e: unknown) => e);
      expect(error, key).to.be.instanceOf(RangeError);
    }
  });

  it('waits through a refused connection and sends once the app connects again', async () => {
    const stub = serveDurable(server, 'docs.submit');
    server.refuse = () => ({ code: 'forbidden', message: 'not now', retryable: false });
    const { connection, queue } = fresh();
    const refused = nextEmit((listener) => connection.events.on('refused', listener));
    connection.connect();
    await refused;

    const done = queue.submit('docs.submit', { n: 1 });
    await sleep(100);
    expect(server.requests).to.have.length(0);

    server.refuse = undefined;
    connection.connect();
    expect(await done).to.deep.equal({ n: 1 });
    expect(stub.runs.get('client-1:1')).to.equal(1);
  });

  it('settles callers in send order even when the replies arrive out of order', async () => {
    server.rawReplies.set('docs.slow', async (request: CommandRequest) => {
      if (request.idempotencyKey === 'client-1:1') {
        await sleep(150);
      }
      return { id: request.id, ok: true, result: request.payload };
    });
    const { queue } = await onlineQueue(server);
    const settled: number[] = [];

    await Promise.all([1, 2, 3].map((n) => queue.submit('docs.slow', { n }).then(() => settled.push(n))));

    expect(settled).to.deep.equal([1, 2, 3]);
  });

  it('validates its options', () => {
    const connection = makeConnection(server);
    const base = { connection, commands: new CommandDispatcher(connection, 1000), store: new MemoryOutboxStore(), clientId: 'client-1' };

    expect(() => new DurableQueue({ ...base, durable: { window: 0 } })).to.throw(RangeError);
    expect(() => new DurableQueue({ ...base, durable: { window: 1.5 } })).to.throw(RangeError);
    expect(() => new DurableQueue({ ...base, durable: { ackTimeoutMs: 0 } })).to.throw(RangeError);
    expect(() => new DurableQueue({ ...base, clientId: 'a b' })).to.throw(RangeError);
  });

  it('ignores a reply that arrives after close, so the entry resumes on the next start', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 100 };
    const { queue, store } = await onlineQueue(server);
    const acked: AckedCommand[] = [];
    queue.events.on('acked', (event) => acked.push(event));

    const done = queue.submit('docs.submit', { n: 1 });
    await until(() => server.requests.length === 1);
    queue.close();
    await rejectionOf(done);
    await sleep(200);

    expect(acked).to.deep.equal([]);
    expect((await store.pending()).map((e) => e.seq)).to.deep.equal([1]);
  });
});
