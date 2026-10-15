import { DI } from '@spinajs/di';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { QueueService } from '@spinajs/queue';
import '@spinajs/orm-sqlite';
import '../../../src/index.js';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { useConfig } from './client.js';
import { STOMP_LOGIN, STOMP_PASSWORD, STOMP_URL } from './env.js';

export interface IAppOptions {
  dbFile: string;
  jobChannel: string;
  topicChannel?: string;
  deadLetterChannel?: string;
  routing?: Record<string, unknown>;
  prefetch?: number;
  retryDelay?: number;
}

export function tempDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'spinajs-queue-it-'));
  return { dir, file: join(dir, 'queue.sqlite') };
}

function sqlite(name: string, filename: string) {
  return { Driver: 'orm-driver-sqlite', Filename: filename, Name: name, Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } };
}

export function appConfig(o: IAppOptions): Record<string, unknown> {
  return {
    app: { name: 'queue-it' },
    db: { DefaultConnection: 'sqlite', Connections: [sqlite('queue', o.dbFile), sqlite('sqlite', ':memory:')] },
    queue: {
      default: 'jobs',
      routing: o.routing ?? {},
      retention: { service: 'DefaultJobRetentionService', enabled: false },
      connections: [
        {
          service: 'StompQueueClient',
          name: 'jobs',
          type: 'job',
          clientId: `queue-it-app-${randomUUID().slice(0, 8)}`,
          host: STOMP_URL,
          login: STOMP_LOGIN,
          password: STOMP_PASSWORD,
          defaultQueueChannel: o.jobChannel,
          defaultTopicChannel: o.topicChannel ?? '/topic/it.unused',
          defaultQueueDeadLetterChannel: o.deadLetterChannel,
          retryDelay: o.retryDelay ?? 0,
          options: { prefetch: o.prefetch ?? 1 },
        },
      ],
    },
  };
}

export async function startApp(o: IAppOptions): Promise<QueueService> {
  await useConfig(appConfig(o));
  await DI.resolve(Orm);
  return DI.resolve(QueueService);
}

export async function stopApp(): Promise<void> {
  const queue = DI.get(QueueService);
  if (queue) {
    await queue.dispose();
  }
  const orm = DI.get(Orm);
  if (orm) {
    await orm.dispose();
  }
}
