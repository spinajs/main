import { isSocketError, type CommandReply, type CommandRequest, type SocketError } from '@spinajs/http-socket-common';
import { CommandDispatcher } from '../../src/commands.js';
import type { Connection } from '../../src/connection.js';
import { DurableQueue, type DurableQueueOptions } from '../../src/durable.js';
import { MemoryOutboxStore, type OutboxStore } from '../../src/outbox.js';
import { track } from './cleanup.js';
import { FAST_RECONNECT, makeConnection, statefulConnection } from './connection.js';
import type { StubServer } from './stub-server.js';
import { waitForState } from './wait.js';

export interface DurableStub {
  /** handler runs by idempotency key */
  readonly runs: Map<string, number>;
  /** idempotency keys in the order their handler ran */
  readonly order: string[];
  /** final replies by key; replays answer with them */
  readonly completed: Map<string, CommandReply>;
}

export interface DurableStubOptions {
  /** A refusal from a stage before idempotency ( authentication, limits ): never stored. */
  refuse?: (request: CommandRequest) => SocketError | undefined;
}

const INTERNAL: SocketError = { code: 'internal', message: 'handler failed', retryable: false };

/**
 * Answers `name` as the W3 server answers a durable command: one run per idempotency key, replays of
 * final replies, retryable failures released, and the `after` fence. Requests run one at a time in
 * arrival order, as `ordered: 'client'` runs them, so the fence is checked at the head of the queue.
 * Keys are not scoped by client: one client per test.
 */
export function serveDurable(server: StubServer, name: string, handler: (payload: any, request: CommandRequest) => unknown = (payload) => payload, options: DurableStubOptions = {}): DurableStub {
  const stub: DurableStub = { runs: new Map(), order: [], completed: new Map() };
  let tail: Promise<unknown> = Promise.resolve();

  server.rawReplies.set(name, (request: CommandRequest): Promise<CommandReply> => {
    const refusal = options.refuse?.(request);
    if (refusal) {
      return Promise.resolve({ id: request.id, ok: false, error: refusal });
    }

    const run = tail.then(() => answer(request));
    tail = run.catch(() => undefined);
    return run;
  });

  const answer = async (request: CommandRequest): Promise<CommandReply> => {
    const key = request.idempotencyKey;
    if (key === undefined) {
      return { id: request.id, ok: false, error: { code: 'invalid_argument', message: 'durable test commands need a key', retryable: false } };
    }

    const done = stub.completed.get(key);
    if (done) {
      return { ...done, id: request.id };
    }

    if (request.after !== undefined && !stub.completed.has(request.after)) {
      return { id: request.id, ok: false, error: { code: 'unavailable', message: `${request.after} has not completed`, retryable: true } };
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
