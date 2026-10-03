import 'mocha';
import { expect } from 'chai';
import type { CommandRequest, SocketError } from '@spinajs/http-socket-common';
import { CommandDispatcher } from '../src/commands.js';
import { DEFAULT_DURABLE, DurableQueue, type AckedCommand, type FailedCommand, type HeldCommand } from '../src/durable.js';
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
    expect(DEFAULT_DURABLE).to.deep.equal({ window: 16, ackTimeoutMs: 60_000, maxPayloadBytes: 1024 * 1024 });
  });

  it('sends in order, keyed clientId:nonce, each after the previous unacknowledged command, without a deadline', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 100 };
    const { queue, store } = await onlineQueue(server);
    const added: string[] = [];
    const add = store.add.bind(store);
    store.add = (async (input: OutboxInput) => {
      added.push(input.key!);
      return add(input);
    }) as OutboxStore['add'];

    const results = await Promise.all([1, 2, 3].map((n) => queue.submit('docs.submit', { n })));

    expect(results).to.deep.equal([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const keys = server.requests.map((r) => r.idempotencyKey!);
    expect(new Set(keys).size).to.equal(3);
    for (const key of keys) {
      expect(key).to.match(/^client-1:\S{16,}$/);
    }
    // persisted with the entry, so a resend after a reload reuses it
    expect(added).to.deep.equal(keys);
    expect(server.requests.map((r) => r.after)).to.deep.equal([undefined, keys[0], keys[1]]);
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
    expect(new Set(server.requests.map((r) => r.idempotencyKey)).size).to.equal(4);
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
    const numberOf = new Map(server.requests.map((r) => [r.idempotencyKey, (r.payload as { n: number }).n]));
    expect(stub.order.map((key) => numberOf.get(key))).to.deep.equal(Array.from({ length: 500 }, (_, n) => n));
    expect([...stub.runs.values()].every((runs) => runs === 1)).to.be.true;
    expect(server.requests.length).to.be.above(500);
    expect(stub.aborted).to.not.be.empty;
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

  it('after a retryable refusal sends only the head until it succeeds, then reopens the window', async () => {
    let refusals = 2;
    serveDurable(server, 'docs.submit', (payload: { n: number }) => {
      if (payload.n === 1 && refusals-- > 0) {
        throw { code: 'resource_exhausted', message: 'busy', retryable: true, retryAfterMs: 30 } as SocketError;
      }
      return payload;
    });
    const { queue } = await onlineQueue(server);

    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => queue.submit('docs.submit', { n })));

    expect(results).to.deep.equal([1, 2, 3, 4, 5].map((n) => ({ n })));
    expect(server.requests.map((r) => (r.payload as { n: number }).n)).to.deep.equal([1, 2, 3, 4, 5, 1, 1, 2, 3, 4, 5]);
  });

  it('parks fenced commands until their predecessor answers, however long it runs', async () => {
    let running = true;
    server.rawReplies.set('docs.stuck', async (request: CommandRequest) => {
      if ((request.payload as { n: number }).n === 1) {
        // still running server-side, but no longer holding the queue place its successors wait behind
        await sleep(300);
        running = false;
        return { id: request.id, ok: true, result: request.payload };
      }
      if (running) {
        return { id: request.id, ok: false, error: { code: 'unavailable', message: 'the predecessor has not completed', retryable: true, details: { after: request.after } } };
      }
      return { id: request.id, ok: true, result: request.payload };
    });
    const { queue } = await onlineQueue(server);

    const results = await Promise.all([1, 2, 3].map((n) => queue.submit('docs.stuck', { n })));

    expect(results).to.deep.equal([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(server.requests.map((r) => (r.payload as { n: number }).n)).to.deep.equal([1, 2, 3, 2, 3]);
  });

  it('sends a fenced command whose predecessor already answered again after a short floor, without a backoff', async () => {
    let fenced = false;
    server.rawReplies.set('docs.fenced', async (request: CommandRequest) => {
      if ((request.payload as { n: number }).n === 2 && !fenced) {
        fenced = true;
        return { id: request.id, ok: false, error: { code: 'unavailable', message: 'the predecessor has not completed', retryable: true, details: { after: request.after } } };
      }
      return { id: request.id, ok: true, result: request.payload };
    });
    const { queue } = await onlineQueue(server, { reconnect: { minMs: 5_000, maxMs: 5_000, jitter: 0 } });
    const started = Date.now();

    const results = await Promise.all([1, 2, 3].map((n) => queue.submit('docs.fenced', { n })));

    expect(results).to.deep.equal([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(server.requests.map((r) => (r.payload as { n: number }).n)).to.deep.equal([1, 2, 3, 2]);
    expect(Date.now() - started).to.be.at.least(45);
  }).timeout(2_000);

  it('refuses a payload above maxPayloadBytes, or one that cannot be encoded, before it reaches the store', async () => {
    serveDurable(server, 'docs.submit');
    const { queue, store } = await onlineQueue(server, { durable: { maxPayloadBytes: 100 } });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const big = await rejectionOf(queue.submit('docs.submit', { text: 'x'.repeat(100) }));
    expect(big.code).to.equal('invalid_argument');
    expect(big.retryable).to.be.false;
    // 56 characters, 104 bytes of UTF-8
    expect((await rejectionOf(queue.submit('docs.submit', { t: '\u017c'.repeat(48) }))).code).to.equal('invalid_argument');
    expect((await rejectionOf(queue.submit('docs.submit', cyclic))).code).to.equal('invalid_argument');
    expect((await rejectionOf(queue.submit('docs.submit', { n: BigInt(1) }))).code).to.equal('invalid_argument');
    expect(await store.pending()).to.deep.equal([]);

    expect(await queue.submit('docs.submit', { text: 'x'.repeat(80) })).to.deep.equal({ text: 'x'.repeat(80) });
    expect(server.requests).to.have.length(1);
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
    expect((await store.failed()).map((e) => e.seq)).to.deep.equal([2]);
    expect(await store.pending()).to.deep.equal([]);
  });

  it('holds a command whose credentials ran out until the connection comes back, instead of failing it', async () => {
    let expired = true;
    const stub = serveDurable(server, 'docs.submit', undefined, { refuse: () => (expired ? { code: 'unauthenticated', message: 'credentials expired', retryable: false } : undefined) });
    const { queue } = await onlineQueue(server);
    const failed: FailedCommand[] = [];
    const held: HeldCommand[] = [];
    queue.events.on('failed', (event) => failed.push(event));
    queue.events.on('held', (event) => held.push(event));

    const done = queue.submit('docs.submit', { n: 1 });
    await until(() => server.requests.length >= 1);
    await sleep(150);
    expect(server.requests).to.have.length(1);
    expect(held).to.have.length(1);
    expect(held[0].entry.payload).to.deep.equal({ n: 1 });
    expect(held[0].error.code).to.equal('unauthenticated');

    // a re-login reconnects
    expired = false;
    server.killConnections();

    expect(await done).to.deep.equal({ n: 1 });
    expect(failed).to.deep.equal([]);
    expect([...stub.runs.values()]).to.deep.equal([1]);
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
    expect(stub.order).to.have.length(2);
    expect(stub.order[0]).to.match(/^client-1:/);
    expect(stub.order[1]).to.equal('op-2');
    expect(server.requests[1].after).to.equal(stub.order[0]);
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
    expect([...stub.runs.values()]).to.deep.equal([1]);
  });

  it('uses an app key verbatim and refuses one the server would refuse', async () => {
    serveDurable(server, 'docs.submit');
    const { queue } = await onlineQueue(server);

    await queue.submit('docs.submit', { n: 1 }, { key: 'op-1' });
    expect(server.requests[0].idempotencyKey).to.equal('op-1');

    // client-1: is the prefix of generated keys, which an app key could collide with
    for (const key of ['', 'a b', 'k'.repeat(257), 'client-1:op-2']) {
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
    expect([...stub.runs.values()]).to.deep.equal([1]);
  });

  it('settles callers in send order even when the replies arrive out of order', async () => {
    server.rawReplies.set('docs.slow', async (request: CommandRequest) => {
      if ((request.payload as { n: number }).n === 1) {
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
    expect(() => new DurableQueue({ ...base, durable: { maxPayloadBytes: 0 } })).to.throw(RangeError);
    expect(() => new DurableQueue({ ...base, durable: { maxPayloadBytes: 1.5 } })).to.throw(RangeError);
    expect(() => new DurableQueue({ ...base, clientId: 'a b' })).to.throw(RangeError);
  });

  it('gives a command submitted after a reload a key no earlier command had, even when the store starts over', async () => {
    const stub = serveDurable(server, 'docs.submit');
    const first = await onlineQueue(server);
    expect(await first.queue.submit('docs.submit', { n: 1 })).to.deep.equal({ n: 1 });
    first.queue.close();
    first.connection.close();

    // a MemoryOutboxStore, a wiped IndexedDB or a deleted file: seq starts at 1 again
    const second = await onlineQueue(server, { store: new MemoryOutboxStore() });
    expect(await second.queue.submit('docs.submit', { n: 2 })).to.deep.equal({ n: 2 });

    expect(stub.runs.size).to.equal(2);
  });

  it('resumes an entry with the key it was first sent with', async () => {
    const stub = serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'drop' };
    const store = new MemoryOutboxStore();
    const first = await onlineQueue(server, { store });
    void first.queue.submit('docs.submit', { n: 1 }).catch(() => undefined);
    await until(() => server.requests.length === 1);
    first.queue.close();
    first.connection.close();

    server.ackFault = { kind: 'none' };
    const second = await onlineQueue(server, { store });
    await until(() => server.requests.length === 2 && second.queue.size === 0);

    expect(server.requests[1].idempotencyKey).to.equal(server.requests[0].idempotencyKey);
    expect([...stub.runs.values()]).to.deep.equal([1]);
    second.queue.close();
  });

  it('settles a command only once the store has applied its outcome', async () => {
    serveDurable(server, 'docs.submit', (payload: { n: number }) => {
      if (payload.n === 2) {
        throw { code: 'invalid_argument', message: 'malformed op', retryable: false } as SocketError;
      }
      return payload;
    });
    const store = new MemoryOutboxStore();
    const remove = store.remove.bind(store);
    const fail = store.fail.bind(store);
    store.remove = async (seq) => {
      await sleep(50);
      return remove(seq);
    };
    store.fail = async (entry) => {
      await sleep(50);
      return fail(entry);
    };
    const { queue } = await onlineQueue(server, { store });

    expect(await queue.submit('docs.submit', { n: 1 })).to.deep.equal({ n: 1 });
    expect(await store.pending()).to.deep.equal([]);
    await rejectionOf(queue.submit('docs.submit', { n: 2 }));
    expect((await store.failed()).map((e) => (e.payload as { n: number }).n)).to.deep.equal([2]);
  });

  it('reports on close the commands that were answered but waited for an earlier one', async () => {
    server.rawReplies.set('docs.slow', async (request: CommandRequest) => {
      if ((request.payload as { n: number }).n === 1) {
        await sleep(300);
      }
      return { id: request.id, ok: true, result: request.payload };
    });
    const { queue } = await onlineQueue(server);
    const acked: AckedCommand[] = [];
    queue.events.on('acked', (event) => acked.push(event));

    const one = queue.submit('docs.slow', { n: 1 });
    const two = queue.submit('docs.slow', { n: 2 });
    await until(() => server.requests.length === 2);
    await sleep(100);
    queue.close();

    expect((await rejectionOf(one)).code).to.equal('unavailable');
    expect(await two).to.deep.equal({ n: 2 });
    expect(acked.map((a) => a.result)).to.deep.equal([{ n: 2 }]);
  });

  it('loads the store again on the next submit when the first load failed', async () => {
    serveDurable(server, 'docs.submit');
    const store = new MemoryOutboxStore();
    await store.add({ name: 'docs.submit', payload: { n: 0 }, key: 'op-0' });
    const pending = store.pending.bind(store);
    let failures = 1;
    store.pending = async () => {
      if (failures-- > 0) {
        throw new Error('storage is busy');
      }
      return pending();
    };
    const errors: unknown[] = [];
    const { queue } = await onlineQueue(server, { store, onListenerError: (error) => errors.push(error) });
    const acked: AckedCommand[] = [];
    queue.events.on('acked', (event) => acked.push(event));

    expect(await queue.submit('docs.submit', { n: 1 })).to.deep.equal({ n: 1 });
    expect(acked.map((a) => a.result)).to.deep.equal([{ n: 0 }, { n: 1 }]);
    expect(errors.map((e) => (e as Error).message)).to.deep.equal(['storage is busy']);
  });

  it('takes the first final reply of any request still out for a command an ack timeout sent again', async () => {
    server.rawReplies.set('docs.late', async (request: CommandRequest) => {
      if (server.requests.indexOf(request) > 0) {
        // the resend hangs: only the first request answers
        return new Promise(() => undefined);
      }
      await sleep(150);
      return { id: request.id, ok: true, result: 'first' };
    });
    const { queue } = await onlineQueue(server, { durable: { ackTimeoutMs: 100 } });

    expect(await queue.submit('docs.late', {})).to.equal('first');
    expect(server.requests).to.have.length(2);
  }).timeout(1_000);

  it('keeps settling when onListenerError throws on a store failure', async () => {
    serveDurable(server, 'docs.submit');
    const store = new MemoryOutboxStore();
    store.remove = async () => {
      throw new Error('disk full');
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { queue } = await onlineQueue(server, {
        store,
        onListenerError: () => {
          throw new Error('the handler broke');
        },
      });

      expect(await queue.submit('docs.submit', { n: 1 })).to.deep.equal({ n: 1 });
      expect(await queue.submit('docs.submit', { n: 2 })).to.deep.equal({ n: 2 });
      await sleep(50);
      expect(unhandled).to.deep.equal([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
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
