import { AsyncLocalStorage } from 'node:async_hooks';

import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { DefaultQueueService, Job, QueueClient, QueueJob, QueueService } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';
import type { BehaviourHarness, HarnessSession, JobRun, JobSpec, QueueHandle, QueueMessage, QueuePeer } from '@spinajs/authz-testing';
import { hostHarness, instantiateWorld, testHost } from '@spinajs/authz-testing';
import type { HostSetup } from '@spinajs/authz-testing';
import { AuthorizationModel, AuthzClock, ChangeBus, DecisionAudit, RelationResolver, ResourceAdapter, ScopeResolver } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';

import { NodeBus, PeerQueueService } from './nodes.js';

import { MemoryBroker, MemoryQueueClient } from './memory-client.js';
import './memory-client.js';

const MIGRATION = { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: 'PerMigration' } };

interface Active {
  readonly authz: AuthzService;
  readonly runs: Map<string, JobRun>;
  readonly checks: Map<string, NonNullable<JobSpec['checks']>>;
}

// DI keys a class by its name, and a message names its class, so a job class is made once and reads the running case from here.
let active: Active | undefined;
const classes = new Map<string, { cls: typeof QueueJob; runAs?: 'initiator' | 'system' }>();

function jobClass(name: string, runAs?: 'initiator' | 'system'): typeof QueueJob {
  const known = classes.get(name);
  if (known) {
    if (known.runAs !== runAs) throw new Error(`queueHarness: job ${name} is declared with runAs ${known.runAs} and ${runAs}`);
    return known.cls;
  }

  class Spec extends QueueJob {
    RetryCount = 0;

    async execute(): Promise<unknown> {
      const { authz, runs, checks } = active!;
      const principal = authz.current();
      const decisions: Awaited<ReturnType<AuthzService['check']>>[] = [];
      for (const check of checks.get(name) ?? []) decisions.push(await authz.check({ principal, permission: check.permission, resource: check.resource }));
      runs.set(this.JobId, { principal, decisions });
      return 'ok';
    }
  }
  Object.defineProperty(Spec, 'name', { value: name });
  Job(runAs ? { runAs } : undefined)(Spec);
  classes.set(name, { cls: Spec as unknown as typeof QueueJob, runAs });
  return Spec as unknown as typeof QueueJob;
}

/** Real QueueService and consumer over an in-memory transport and an in-memory SQLite job table. */
interface RunningPeer extends QueuePeer {
  dispose(): Promise<void>;
}

async function startPeer(host: HostSetup, connection: string): Promise<RunningPeer> {
  const name = `${host.domain}-peer`;
  const kit = instantiateWorld(host.world);
  const client = new MemoryQueueClient({ name: `${connection}-peer`, options: { broker: connection } } as never);
  await client.resolve();
  const bus = new NodeBus(new PeerQueueService(client));

  // The peer is configured like the test domain: same permissions, combination and cache settings.
  const own = testHost.config().get<unknown>(['authz', 'domains', host.domain]);
  host.setConfig(['authz', 'domains', name], JSON.parse(JSON.stringify(own)));

  const domains = await testHost.domains();
  const container = domains.create(name, 'root');
  for (const m of kit.models) container.register(testHost.instance(m)).as(AuthorizationModel);
  for (const a of kit.adapters) container.register(testHost.instance(a)).as(ResourceAdapter);
  for (const r of kit.scopeResolvers) container.register(testHost.instance(r)).as(ScopeResolver);
  for (const r of kit.relations) container.register(testHost.instance(r)).as(RelationResolver);
  container.register(testHost.instance(kit.audit)).as(DecisionAudit);
  container.register(testHost.instance(kit.clock)).as(AuthzClock);
  container.register(testHost.instance(bus)).as(ChangeBus);

  const authz = await domains.service(name);
  await bus.ready();

  return {
    authz: authz as never,
    kit,
    async dispose() {
      await bus.dispose();
      await container.dispose();
      client.unsubscribe();
      await client.dispose();
    },
  };
}

export function queueHarness(): BehaviourHarness {
  let seq = 0;
  let connection = '';
  let nodeBus: NodeBus;

  return hostHarness({
    facets: ['queue'],

    register(host) {
      connection = `authz-queue-test-${++seq}`;
      nodeBus = new NodeBus();
      host.setConfig(['authz', 'queue', 'domain'], host.domain);
      host.setConfig(['authz', 'orm', 'domain'], host.domain);
      host.setConfig(['db'], {
        DefaultConnection: 'queue',
        Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'queue', Migration: MIGRATION }],
      });
      host.setConfig(['queue'], {
        default: connection,
        routing: {},
        connections: [{ service: 'MemoryQueueClient', name: connection, defaultQueueChannel: '/queue/test', defaultTopicChannel: '/topic/test', options: { broker: connection } }],
      });
      if (host.ctx.facets.includes('bus')) host.container.register(testHost.instance(nodeBus)).as(ChangeBus);
      host.setConfig(['logger'], { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
    },

    async extend(host, session: HarnessSession): Promise<Partial<HarnessSession>> {
      const authz = session.authz as unknown as AuthzService;
      const runs = new Map<string, JobRun>();
      const jobs = new Map<string, typeof QueueJob>();

      active = { authz, runs, checks: new Map() };
      for (const spec of host.world.lane?.queue?.jobs ?? []) {
        active.checks.set(spec.name, spec.checks ?? []);
        jobs.set(spec.name, jobClass(spec.name, spec.runAs));
      }

      const orm = await DI.resolve(Orm);
      const queue = await DI.resolve(QueueService);
      for (const cls of jobs.values()) await queue.consume(cls as never);
      const client = queue.get(connection) as unknown as MemoryQueueClient;

      // A second node is already running when the first publishes, so it starts with the case.
      const peer = host.ctx.facets.includes('bus') ? await startPeer(host, connection) : undefined;
      const handle: QueueHandle = {
        async emit(job: string, payload?: Readonly<Record<string, unknown>>): Promise<QueueMessage> {
          const cls = jobs.get(job);
          if (!cls) throw new Error(`queueHarness: no job ${job} in the world`);
          const id = await (cls as unknown as { emit(v: object): Promise<string | undefined> }).emit({ ...payload });
          const wire = client.Emitted.find((m) => (m as { JobId?: string }).JobId === id);
          if (!wire) throw new Error(`queueHarness: ${job} reached no transport`);
          return wire as unknown as QueueMessage;
        },

        async handle(message: QueueMessage): Promise<JobRun> {
          // The consumer of a real broker runs outside the emitter's async context.
          await DI.resolve(AsyncLocalStorage).exit(() => client.deliver(JSON.parse(JSON.stringify(message)) as unknown as IQueueMessage));
          const run = runs.get((message as { JobId?: string }).JobId ?? '');
          if (!run) throw new Error('queueHarness: the handler did not run');
          return run;
        },

        async peer() {
          if (!peer) throw new Error('queueHarness: the part needs the bus facet to have a peer node');
          return peer;
        },
      };

      return {
        lane: { queue: handle },
        bus: nodeBus,
        async dispose() {
          await peer?.dispose();
          await nodeBus.dispose();
          await queue.dispose();
          await orm.dispose();
          MemoryBroker.drop((client.Options.options as { broker: string }).broker);
          active = undefined;
          DI.uncache(QueueService);
          DI.uncache(DefaultQueueService);
          DI.uncache(QueueClient);
          DI.uncache(MemoryQueueClient);
          DI.uncache(Orm);
        },
      };
    },
  });
}
