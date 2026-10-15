import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { Job, QueueJob, QueueService } from '@spinajs/queue';
import '@spinajs/orm-sqlite';
import '@spinajs/queue-stomp-transport';

const env = process.env;
const REPLICA = env.REPLICA_NAME;

function send(message) {
  return new Promise((resolve) => process.send({ replica: REPLICA, ...message }, () => resolve()));
}

function sqlite(name, filename) {
  return { Driver: 'orm-driver-sqlite', Filename: filename, Name: name, Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } };
}

class ReplicaConf extends FrameworkConfiguration {
  onLoad() {
    return {
      app: { name: 'queue-it-replica' },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { DefaultConnection: 'sqlite', Connections: [sqlite('queue', env.DB_FILE), sqlite('sqlite', ':memory:')] },
      queue: {
        default: 'jobs',
        routing: {},
        retention: { service: 'DefaultJobRetentionService', enabled: false },
        connections: [
          {
            service: 'StompQueueClient',
            name: 'jobs',
            type: 'job',
            host: env.STOMP_URL,
            login: env.STOMP_LOGIN,
            password: env.STOMP_PASSWORD,
            defaultQueueChannel: env.CHANNEL,
            options: { prefetch: Number(env.PREFETCH ?? '1') },
          },
        ],
      },
    };
  }
}

class ReplicaJob extends QueueJob {
  async execute() {
    await send({ type: 'started', jobId: this.JobId });
    if (this.HangOn === REPLICA) {
      await new Promise(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, this.DurationMs ?? 50));
    return { replica: REPLICA };
  }
}
Job()(ReplicaJob);

try {
  DI.register(ReplicaConf).as(Configuration);
  await DI.resolve(Configuration);
  await DI.resolve(Orm);
  const queue = await DI.resolve(QueueService);

  await queue.consume(ReplicaJob, async (job) => {
    await send({ type: 'succeeded', jobId: job.JobId });
    if (job.CrashAfterSuccessOn === REPLICA) {
      process.kill(process.pid, 'SIGKILL');
    }
  });

  process.on('message', async (message) => {
    if (message?.type === 'stop') {
      await queue.dispose();
      process.exit(0);
    }
  });

  await send({ type: 'ready' });
} catch (err) {
  const reasons = [err?.message, err?.inner?.message, err?.cause?.message].filter(Boolean);
  await send({ type: 'failed', message: reasons.length ? reasons.join(' | ') : String(err) });
  process.exit(1);
}
