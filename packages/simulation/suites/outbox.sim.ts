import { v5 as uuidv5 } from 'uuid';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import '@spinajs/idempotency';
import { Event, isRedeliverLater, OutboxRelay, QueueClient, QueueEvent, QueueService, type IQueueMessage } from '@spinajs/queue';
import { MemoryBroker, MemoryQueueClient, wireCopy } from '@spinajs/queue/testing';
import { countBy, currentReplicaId, ensure, invariant, overLimit, runInContext, type FaultRule, type SimActor, type SimEnv, type SimSuite, type SimSystem } from '../src/index.js';

const MESSAGE_NAMESPACE = '5b0c3f8e-6d1a-4a57-9a35-2f4e8c1d7b60';
const BROKER = 'sim-mem';
const CLAIM_TTL = 30_000;
const RELAYS = ['relay-1', 'relay-2'];
const CONSUMERS = ['consumer-1', 'consumer-2'];

@Event()
export class SimPing extends QueueEvent {
  public Seq: number;
}

class SimRollback extends Error {}

export interface OutboxSeedStats {
  /** Deliveries refused with RedeliverLater: a copy that arrived while another claim held its dedup key. */
  inFlightDuplicates: number;
}

let stats: OutboxSeedStats = { inFlightDuplicates: 0 };

/** The memory transport, counting the deliveries its subscribers refuse with RedeliverLater. */
@PerInstanceCheck()
@Injectable(QueueClient)
export class ObservedMemoryQueueClient extends MemoryQueueClient {
  public override subscribe(...args: Parameters<MemoryQueueClient['subscribe']>): Promise<void> {
    const [channel, callback, ...rest] = args;
    const observed = async (message: IQueueMessage): Promise<void> => {
      try {
        await callback(message);
      } catch (error) {
        if (isRedeliverLater(error)) stats.inFlightDuplicates++;
        throw error;
      }
    };
    return super.subscribe(channel, observed, ...rest);
  }
}

interface IdRow {
  MessageId: string;
}

interface OutboxStatusRow {
  MessageId: string;
  Status: string;
}

export const OUTBOX_FAULTS: FaultRule[] = [
  { point: 'outbox.after-insert', when: { probability: 0.05 }, effect: 'crash' },
  { point: 'outbox.after-publish', when: { probability: 0.03 }, effect: 'crash' },
  { point: 'outbox.after-publish', when: { probability: 0.03 }, effect: 'delay', delayMs: CLAIM_TTL + 5_000 },
  { point: 'outbox.after-publish', when: { probability: 0.1 }, effect: 'duplicate' },
  { point: 'outbox.before-mark', when: { probability: 0.05 }, effect: 'crash' },
  // the consumer dies with its handler's work committed, the reply stored and the message unsettled: it is delivered again
  { point: 'queue.before-ack', when: { probability: 0.05 }, effect: 'crash' },
  // the consumer dies holding the dedup key, before the handler ran: until the lease ends every delivery of that message is refused
  { point: 'idempotency.after-claim', when: { probability: 0.1 }, effect: 'crash' },
];

export interface OutboxSuiteOptions {
  /** Self-test: false turns event deduplication off, so a redelivery is handled twice. */
  deduplicate?: boolean;
  faults?: FaultRule[];
  /** Receives the stats of each seed when it is disposed. */
  observe?: (stats: OutboxSeedStats) => void;
}

export function outboxSuite(o: OutboxSuiteOptions = {}): SimSuite {
  return {
    name: 'outbox',
    steps: 200,
    options: { faults: o.faults ?? OUTBOX_FAULTS, pausableReplicas: RELAYS, maxPauseMs: 2 * CLAIM_TTL },
    build: (env) => buildOutbox(env, o),
  };
}

export const OUTBOX_SUITE = outboxSuite();

async function buildOutbox(env: SimEnv, o: OutboxSuiteOptions): Promise<SimSystem> {
  const brokerName = `sim-${env.seed}`;
  // MemoryBroker keeps its brokers in a static map: a run of the same seed that failed must not leave deliveries behind
  MemoryBroker.drop(brokerName);
  const seedStats: OutboxSeedStats = { inFlightDuplicates: 0 };
  stats = seedStats;
  await env.boot({
    template: 'outbox',
    aliases: ['queue', 'idempotency'],
    config: {
      queue: {
        default: BROKER,
        routing: {},
        connections: [{ service: 'ObservedMemoryQueueClient', name: BROKER, defaultQueueChannel: '/queue/sim', defaultTopicChannel: '/topic/sim', options: { broker: brokerName, deferred: true } }],
        deduplicateEvents: o.deduplicate ?? true,
        deduplicateTtl: '7d',
        // relay: false, so the queue service starts no relay of its own; the harness ticks one relay per replica
        outbox: { enabled: true, relay: false, connections: ['default'], mode: 'when-in-transaction', tick: 1000, batchSize: 5, claimTtl: CLAIM_TTL, maxPublishMs: 10_000, maxAge: '24h', backoff: { backoff: 'fixed', delay: 1000 }, retention: '7d' },
      },
      idempotency: { store: 'OrmIdempotencyStore', lease: '30s', sweepBatch: 500 },
    },
  });
  const db = env.database.driver;
  await db.schema().createTable('sim_outbox_intent', (t) => {
    t.string('MessageId', 36).primaryKey().notNull();
    t.int('Seq').notNull();
    t.string('Replica', 32).notNull();
  });
  await db.schema().createTable('sim_outbox_handled', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.string('MessageId', 36).notNull();
  });

  const queue = await DI.resolve(QueueService);
  const client = queue.get(BROKER);
  if (!(client instanceof MemoryQueueClient)) throw new Error(`outbox suite: connection ${BROKER} is not a MemoryQueueClient`);
  const duplicates: number[] = [];
  env.faults.onDuplicate(() => duplicates.push(client.published.length - 1));
  await queue.consume<SimPing>(
    SimPing,
    async (message) => {
      await db.insert().into('sim_outbox_handled').values({ MessageId: message.MessageId });
    },
    'sim-consumer',
  );

  const relays = new Map<string, OutboxRelay>();
  const startRelay = async (replica: string): Promise<void> => {
    // without the seeded random, backoff jitter draws Math.random and seed replay breaks at the first publish failure
    relays.set(replica, await DI.resolve(OutboxRelay, [{ replicaId: currentReplicaId(), autoStart: false, random: () => env.random.next() }]));
  };
  for (const replica of RELAYS) await runInContext(env.replicas.context(replica), () => startRelay(replica));

  let seq = 0;
  const app = (name: string): SimActor => ({
    name,
    replica: name,
    tick: async () => {
      if (env.quiescing) return;
      const n = ++seq;
      const id = uuidv5(`${env.seed}:${n}`, MESSAGE_NAMESPACE);
      const rollback = env.random.chance(0.5);
      try {
        await db.transaction(async () => {
          await db.insert().into('sim_outbox_intent').values({ MessageId: id, Seq: n, Replica: currentReplicaId() });
          await queue.emit(new SimPing({ Seq: n, MessageId: id }));
          if (rollback) throw new SimRollback();
        });
      } catch (err) {
        if (!(err instanceof SimRollback)) throw err;
      }
    },
    restart: () => Promise.resolve(),
  });
  const relayOf = (name: string): OutboxRelay => {
    const instance = relays.get(name);
    if (!instance) throw new Error(`outbox suite: relay ${name} was not started`);
    return instance;
  };
  const relay = (name: string): SimActor => ({ name, replica: name, tick: () => relayOf(name).tick(), restart: () => startRelay(name) });
  // two replicas, one client, one subscription: they crash separately and take turns on the same broker queue
  const consumer = (name: string): SimActor => ({
    name,
    replica: name,
    tick: async () => {
      for (const index of duplicates.splice(0)) await client.emit(wireCopy(client.published[index]));
      await client.deliverAll();
    },
    restart: () => Promise.resolve(),
  });

  const committed = async (): Promise<Set<string>> => new Set((await db.select<IdRow[]>().from('sim_outbox_intent')).map((r) => r.MessageId));
  const handled = async (): Promise<string[]> => (await db.select<IdRow[]>().from('sim_outbox_handled')).map((r) => r.MessageId);
  const published = (): string[] => client.published.map((m) => m.MessageId ?? '');

  return {
    // the consumers come last, so a quiescence round delivers what the relays published in it
    actors: [app('app-1'), app('app-2'), ...RELAYS.map(relay), ...CONSUMERS.map(consumer)],
    invariants: [
      invariant('no-rolled-back-message-escapes', async () => {
        const ok = await committed();
        const escaped = [...new Set([...published(), ...(await handled())])].filter((id) => !ok.has(id)).sort();
        ensure(escaped.length === 0, 'a message whose transaction rolled back was published or handled', escaped);
      }),
      invariant('handled-at-most-once', async () => {
        const twice = overLimit(await handled(), (id) => id);
        ensure(twice.length === 0, 'a message was handled more than once', twice);
      }),
      invariant(
        'every-committed-message-delivered',
        async () => {
          const seen = new Set(published());
          const missing = [...(await committed())].filter((id) => !seen.has(id)).sort();
          ensure(missing.length === 0, 'a committed message was never published', missing);
        },
        { final: true },
      ),
      invariant(
        'every-committed-message-handled-once',
        async () => {
          const counts = countBy(await handled(), (id) => id);
          const wrong = [...(await committed())].filter((id) => counts.get(id) !== 1).sort();
          ensure(wrong.length === 0, 'a committed message was not handled exactly once', wrong);
        },
        { final: true },
      ),
      invariant(
        'no-row-stuck-pending',
        async () => {
          const stuck = await db.select<OutboxStatusRow[]>().from('queue_outbox').whereIn('Status', ['pending', 'dead']);
          ensure(stuck.length === 0, 'outbox rows left undelivered after quiescence', stuck.map((r) => `${r.MessageId}:${r.Status}`));
        },
        { final: true },
      ),
    ],
    workload: () => Promise.resolve(),
    // an empty outbox is not enough: a message whose first consumer died holding the key is handled only after the lease
    quiesced: async () => {
      const pending = await db.select<OutboxStatusRow[]>().from('queue_outbox').where('Status', 'pending');
      if (pending.length > 0) return false;
      const done = new Set(await handled());
      return [...(await committed())].every((id) => done.has(id));
    },
    dispose: () => {
      MemoryBroker.drop(brokerName);
      o.observe?.(seedStats);
      return Promise.resolve();
    },
  };
}
