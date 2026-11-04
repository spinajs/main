import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';
import { WORKFLOW_CONNECTION } from '../workflow-config.js';

// Times are BIGINT epoch milliseconds from the database clock; JSON is LONGTEXT read through @Json()
// (the scheduler's conventions, Scheduler_2026_10_15_00_00_00).
@Migration(WORKFLOW_CONNECTION)
export class Workflow_2026_11_10_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('__workflow', (t) => {
      t.string('Id', 128).primaryKey().notNull();
      t.string('Workflow', 128).notNull();
      t.int('Version').notNull();
      t.string('Status', 16).notNull();
      t.string('Reason', 64);
      t.longtext('Input');
      t.longtext('Result');
      t.longtext('Error');
      t.bigint('WakeAt');
      t.string('WaitingFor', 128);
      t.int('Attempt').notNull();
      t.string('ClaimedBy', 64);
      t.bigint('ClaimedUntil');
      t.int('ClaimEpoch').notNull().default().value(0);
      // A numeric default compiles to DEFAULT 0 on MySQL/SQLite and DEFAULT FALSE on Postgres.
      t.boolean('CancelRequested').notNull().default().value(0);
      t.bigint('CreatedAt').notNull();
      t.bigint('UpdatedAt').notNull();
      t.bigint('FinishedAt');
    });

    await connection.schema().createTable('__workflow_step', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('InstanceId', 128).notNull();
      t.int('Seq').notNull();
      t.string('Key', 200).notNull();
      t.string('Kind', 16).notNull();
      t.string('Status', 16).notNull();
      t.int('Attempt').notNull();
      t.longtext('Result');
      t.boolean('ResultStored').notNull().default().value(0);
      t.longtext('Error');
      t.longtext('Meta');
      t.bigint('StartedAt').notNull();
      t.bigint('FinishedAt');
    });

    await connection.schema().createTable('__workflow_event', (t) => {
      t.bigint('Id').primaryKey().autoIncrement();
      t.string('InstanceId', 128).notNull();
      t.string('Name', 128).notNull();
      t.longtext('Payload');
      t.string('Principal', 200);
      t.string('DedupKey', 128);
      t.string('State', 16).notNull();
      t.string('ConsumedByKey', 200);
      t.bigint('ReceivedAt').notNull();
    });

    await connection.index().table('__workflow').name('__workflow_due').columns(['Status', 'WakeAt']);
    await connection.index().table('__workflow').name('__workflow_version').columns(['Workflow', 'Version', 'Status']);
    await connection.index().unique().table('__workflow_step').name('__workflow_step_key').columns(['InstanceId', 'Key']);
    await connection.index().table('__workflow_step').name('__workflow_step_seq').columns(['InstanceId', 'Seq']);
    await connection.index().unique().table('__workflow_event').name('__workflow_event_dedup').columns(['InstanceId', 'DedupKey']);
    await connection.index().table('__workflow_event').name('__workflow_event_pending').columns(['InstanceId', 'Name', 'State', 'Id']);
  }

  public down(_connection: OrmDriver): Promise<void> {
    return Promise.resolve();
  }
}
