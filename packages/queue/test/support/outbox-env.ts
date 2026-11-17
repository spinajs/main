import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, Constructor, DI, Injectable, PerInstanceCheck, type ContainerSnapshot } from '@spinajs/di';
import { Clock, DbTimeSource, FaultInjector, type FaultPointName } from '@spinajs/durable';
import { FakeClock } from '@spinajs/durable/testing';
import { MigrationTransactionMode, Orm, OrmDriver } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import '@spinajs/log';
import { Event, hydrateOutboxMessage, IQueueMessage, Job, OUTBOX_TABLE, OutboxRow, QueueClient, QueueEvent, QueueJob, QueueMessage, QueueService, toOutboxRow, type IQueueOutboxConfig } from '../../src/index.js';
import { MemoryQueueClient } from '../../src/testing/index.js';

export const T0 = Date.parse('2026-11-16T10:00:00.000Z');

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle: () => void = () => undefined;
  // the executor runs before the constructor returns, so `settle` is the promise's own by the next line
  const promise = new Promise<void>((resolve) => (settle = resolve));
  return { promise, resolve: settle };
}

/** Real time: for the cases that wait for work nobody hands the test a promise for. */
export async function eventually(done: () => boolean | Promise<boolean>, withinMs = 10_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`not reached within ${withinMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

@Event()
export class OrderPlaced extends QueueEvent {
  public OrderId: string;
}

@Job()
export class BuildReport extends QueueJob {
  public async execute(): Promise<unknown> {
    return 'ok';
  }
}

export function orderIdOf(message: IQueueMessage): string {
  if ('OrderId' in message && typeof message.OrderId === 'string') return message.OrderId;
  throw new TypeError(`${message.Name} carries no OrderId`);
}

/** A `crash: true` error stands for a dead process. */
export class TestCrash extends Error {
  public readonly crash = true;
}

export interface SentMessage {
  connection: string;
  message: IQueueMessage;
}

interface RecordingBroker {
  sent: SentMessage[];
  failures: Map<string, Error[]>;
  gate: Promise<void> | undefined;
  onEmit: (() => void) | undefined;
  reset(): void;
}

/** Records what reached each queue connection; `failures` and `gate` steer the next emits. */
export const broker: RecordingBroker = {
  sent: [],
  failures: new Map(),
  gate: undefined,
  onEmit: undefined,
  reset(): void {
    this.sent = [];
    this.failures.clear();
    this.gate = undefined;
    this.onEmit = undefined;
  },
};

@PerInstanceCheck()
@Injectable(QueueClient)
export class RecordingQueueClient extends QueueClient {
  public async emit(message: IQueueMessage): Promise<void> {
    broker.onEmit?.();
    if (broker.gate) await broker.gate;
    const failure = broker.failures.get(this.Name)?.shift();
    if (failure) throw failure;
    // the copy a broker round trip leaves, read back through the outbox's own guard
    broker.sent.push({ connection: this.Name, message: hydrateOutboxMessage(JSON.stringify(message)) });
  }

  public async subscribe(_channel: string | Constructor<QueueMessage>, _callback: (e: IQueueMessage) => Promise<void>): Promise<void> {
    await Promise.resolve();
  }

  public unsubscribe(): void {}
}

export const faultsHit: { name: FaultPointName; detail?: Record<string, unknown> }[] = [];

export class RecordingFaults extends FaultInjector {
  public crashAt?: FaultPointName;

  public point(name: FaultPointName, detail?: Record<string, unknown>): void {
    faultsHit.push({ name, detail });
    if (name === this.crashAt) throw new TestCrash(`crash at ${name}`);
  }
}

export interface OutboxEnvOptions {
  outbox?: Partial<IQueueOutboxConfig>;
  /** `queue.outbox` values as a configuration file can carry them and the type cannot (null, a boolean); laid over `outbox`. */
  rawOutbox?: Record<string, unknown>;
  routing?: Record<string, unknown>;
  /** Leaves `Clock` and `DbTimeSource` to their defaults (real timers, database time); `clock` is then not wired in. */
  realTimers?: boolean;
  /** Runs every registered Bootstrapper before the Configuration resolves, as an app boot does: the queue's schemas then validate and coerce the configuration. */
  bootstrap?: boolean;
  /** Registrations of one test, made after the defaults and before anything resolves. */
  register?: () => void;
}

const sqlite = (name: string) => ({
  Driver: 'orm-driver-sqlite',
  Filename: ':memory:',
  Name: name,
  Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

export interface OutboxDb {
  clock: FakeClock;
  faults: RecordingFaults;
  orders: OrmDriver;
  billing: OrmDriver;
  /** The `queue` connection (JobModel), which `queue.outbox.connections` does not list. */
  uncovered: OrmDriver;
}

export interface OutboxEnv extends OutboxDb {
  queue: QueueService;
}

function connection(orm: Orm, name: string): OrmDriver {
  const driver = orm.Connections.get(name);
  if (!driver) throw new Error(`test connection ${name} is missing`);
  return driver;
}

let current: OutboxEnvOptions = {};

// The registrations before a boot. clearCache() keeps values, so a configuration schema registered by one boot would
// otherwise validate the configuration of every later one.
let beforeBoot: ContainerSnapshot | undefined;

// One class at module level: DI keeps the first class registered under a name.
class OutboxConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { DefaultConnection: 'orders', Connections: [sqlite('orders'), sqlite('billing'), sqlite('queue')] },
      queue: {
        default: 'bus-a',
        routing: current.routing ?? {},
        connections: [
          { service: 'RecordingQueueClient', name: 'bus-a', defaultQueueChannel: '/queue/a', defaultTopicChannel: '/topic/a' },
          { service: 'RecordingQueueClient', name: 'bus-b', defaultQueueChannel: '/queue/b', defaultTopicChannel: '/topic/b' },
        ],
        outbox: { enabled: true, relay: false, connections: ['orders', 'billing'], ...current.outbox, ...current.rawOutbox },
      },
    };
  }
}

/** Two outbox connections ( `orders`, the default, and `billing` ), `queue` for JobModel, two recording brokers. QueueService is not resolved. */
export async function bootOutboxDb(o: OutboxEnvOptions = {}): Promise<OutboxDb> {
  DI.clearCache();
  beforeBoot ??= DI.snapshot();
  broker.reset();
  faultsHit.length = 0;
  current = o;
  const clock = new FakeClock(T0);
  const faults = new RecordingFaults();
  DI.register(OutboxConf).as(Configuration);
  if (!o.realTimers) {
    DI.register(() => clock).as(Clock);
    DI.register(() => clock.dbSource).as(DbTimeSource);
  }
  DI.register(() => faults).as(FaultInjector);
  o.register?.();
  if (o.bootstrap) {
    for (const bootstrapper of await DI.resolve(Array.ofType(Bootstrapper))) await bootstrapper.bootstrap();
  }
  await DI.resolve(Configuration);
  const orm = await DI.resolve(Orm);
  await orm.Migrator.ready();
  return { clock, faults, orders: connection(orm, 'orders'), billing: connection(orm, 'billing'), uncovered: connection(orm, 'queue') };
}

export async function bootOutbox(o: OutboxEnvOptions = {}): Promise<OutboxEnv> {
  const db = await bootOutboxDb(o);
  return { ...db, queue: await DI.resolve(QueueService) };
}

export async function outboxRows(driver: OrmDriver): Promise<OutboxRow[]> {
  const raw = await driver.select<Record<string, unknown>[]>().from(OUTBOX_TABLE).orderBy('Id');
  return raw.map(toOutboxRow);
}

export async function disposeOutbox(): Promise<void> {
  if (beforeBoot) {
    await DI.restore(beforeBoot);
    beforeBoot = undefined;
  } else {
    await DI.dispose();
  }
  DI.clearCache();
}

export function memoryClientOf(queue: QueueService, name: string): MemoryQueueClient {
  const client = queue.get(name);
  if (!(client instanceof MemoryQueueClient)) throw new Error(`queue connection ${name} is not a MemoryQueueClient`);
  return client;
}
