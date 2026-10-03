import { isSocketError, type CommandReply, type CommandRequest, type SocketError } from '@spinajs/http-socket-common';
import { CommandDispatcher } from '../../src/commands.js';
import type { Connection } from '../../src/connection.js';
import { DurableQueue, type DurableQueueOptions } from '../../src/durable.js';
import { MemoryOutboxStore, type OutboxStore } from '../../src/outbox.js';
import { track } from './cleanup.js';
import { FAST_RECONNECT, makeConnection, statefulConnection } from './connection.js';
import type { StubServer } from './stub-server.js';
import { sleep, waitForState } from './wait.js';

export interface DurableStub {
  /** handler runs by idempotency key */
  readonly runs: Map<string, number>;
  /** idempotency keys in the order their handler ran */
  readonly order: string[];
  /** final replies by key; replays answer with them */
  readonly completed: Map<string, CommandReply>;
  /** keys of requests a kill aborted before they ran */
  readonly aborted: string[];
}

export interface DurableStubOptions {
  /** A refusal from a stage before idempotency ( authentication, limits ): never stored. */
  refuse?: (request: CommandRequest) => SocketError | undefined;
  /** Seeds the delays before the fence. */
  seed?: number;
  /** Upper bound of the random delay before the fence; 0 turns it off. */
  maxFenceDelayMs?: number;
}

/** mulberry32: a deterministic sequence per seed, so the delays repeat from run to run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const INTERNAL: SocketError = { code: 'internal', message: 'handler failed', retryable: false };

/**
 * Answers `name` as the W3 server answers a durable command: one run per idempotency key, replays of
 * final replies, retryable failures released, and the `after` fence. Requests run one at a time in
 * arrival order, as `ordered: 'client'` runs them, so the fence is checked at the head of the queue,
 * after a random delay. `server.killConnections()` aborts the requests that have not started running,
 * as a disconnect does: their keys stay unclaimed and a resend claims them. Keys are not scoped by
 * client: one client per test.
 */
export function serveDurable(server: StubServer, name: string, handler: (payload: any, request: CommandRequest) => unknown = (payload) => payload, options: DurableStubOptions = {}): DurableStub {
  const stub: DurableStub = { runs: new Map(), order: [], completed: new Map(), aborted: [] };
  const random = seededRandom(options.seed ?? 1);
  const maxFenceDelayMs = options.maxFenceDelayMs ?? 3;
  let tail: Promise<unknown> = Promise.resolve();
  let generation = 0;

  const kill = server.killConnections.bind(server);
  server.killConnections = () => {
    generation++;
    kill();
  };

  server.rawReplies.set(name, (request: CommandRequest): Promise<CommandReply> => {
    const refusal = options.refuse?.(request);
    if (refusal) {
      return Promise.resolve({ id: request.id, ok: false, error: refusal });
    }

    const born = generation;
    const run = tail.then(() => answer(request, born));
    tail = run.catch(() => undefined);
    return run;
  });

  const answer = async (request: CommandRequest, born: number): Promise<CommandReply> => {
    const key = request.idempotencyKey;
    if (key === undefined) {
      return { id: request.id, ok: false, error: { code: 'invalid_argument', message: 'durable test commands need a key', retryable: false } };
    }

    if (maxFenceDelayMs > 0) {
      await sleep(Math.floor(random() * (maxFenceDelayMs + 1)));
    }

    // its connection died while it waited: the reply goes nowhere
    if (born !== generation) {
      stub.aborted.push(key);
      return { id: request.id, ok: false, error: { code: 'unavailable', message: 'the connection closed', retryable: true } };
    }

    const done = stub.completed.get(key);
    if (done) {
      return { ...done, id: request.id };
    }

    if (request.after !== undefined && !stub.completed.has(request.after)) {
      return { id: request.id, ok: false, error: { code: 'unavailable', message: `${request.after} has not completed`, retryable: true, details: { after: request.after } } };
    }

    stub.runs.set(key, (stub.runs.get(key) ?? 0) + 1);
    stub.order.push(key);

    let reply: CommandReply;
    try {
      const result = await handler(request.payload, request);
      reply = { id: request.id, ok: true, result: result === undefined ? null : result };
    } catch (error) {
      const wire = isSocketError(error) ? error : INTERNAL;
      if (wire.retryable) {
        return { id: request.id, ok: false, error: wire };
      }
      reply = { id: request.id, ok: false, error: wire };
    }

    stub.completed.set(key, reply);
    return reply;
  };

  return stub;
}

export async function onlineQueue(server: StubServer, options: Partial<DurableQueueOptions> = {}): Promise<{ connection: Connection; queue: DurableQueue; store: OutboxStore }> {
  const connection = makeConnection(server);
  const store = options.store ?? new MemoryOutboxStore();
  const queue = track(new DurableQueue({ connection, commands: new CommandDispatcher(connection, 1000), store, clientId: 'client-1', reconnect: FAST_RECONNECT, ...options }));
  connection.connect();
  await waitForState(statefulConnection(connection), 'online');
  return { connection, queue, store };
}
