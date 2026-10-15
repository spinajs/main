/* eslint-disable @typescript-eslint/no-unused-vars */
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

// Times are BIGINT epoch milliseconds (UTC): DATETIME round-trips are zone- and
// precision-dependent across the three drivers, and lease checks need exact equality.
@Migration('default')
export class Scheduler_2026_10_15_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('__scheduler', (t) => {
      t.string('Name', 128).primaryKey().notNull();
      t.json('Definition').notNull();
      t.string('DefinitionHash', 64).notNull();
      t.bigint('NextRunAt');
      t.bigint('LastFiredAt');
      t.bigint('LastFinishedAt');
      t.string('LastStatus', 16);
      t.string('LastRunId', 36);
      t.boolean('Paused').notNull();
      t.string('PausedReason', 16);
      t.boolean('HardPaused').notNull();
      t.int('ConsecutiveFailures').notNull();
      t.bigint('LastSuccessAt');
      t.string('LeaseOwner', 128);
      t.bigint('LeaseUntil');
      t.boolean('Orphaned').notNull();
      t.bigint('UpdatedAt').notNull();
    });

    await connection.schema().createTable('__scheduler_run', (t) => {
      t.string('Id', 36).primaryKey().notNull();
      t.string('Schedule', 128).notNull();
      t.string('Trigger', 16).notNull();
      t.json('TriggeredBy');
      t.string('ParentRunId', 36);
      t.json('Params');
      t.string('Status', 16).notNull();
      t.string('Reason', 64);
      t.int('Attempt').notNull();
      t.int('MaxAttempts').notNull();
      t.bigint('NextAttemptAt');
      t.bigint('ScheduledAt');
      t.bigint('CreatedAt').notNull();
      t.bigint('StartedAt');
      t.bigint('FinishedAt');
      t.bigint('UpdatedAt');
      t.int('Progress').notNull();
      t.string('CurrentStep', 128);
      t.text('Message');
      t.json('Checkpoint');
      t.json('Result');
      t.json('Error');
      t.string('JobId', 36);
      t.string('LeaseOwner', 128);
      t.bigint('LeaseUntil');
      t.boolean('CancelRequested').notNull();
      t.boolean('Forced').notNull();
      t.json('ResumeFrom');
      // nullable: a boolean default is not portable to Postgres through the schema builder
      t.boolean('ProgressCapped');
    });

    await connection.schema().createTable('__scheduler_run_attempt', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('RunId', 36).notNull();
      t.int('Attempt').notNull();
      t.bigint('StartedAt').notNull();
      t.bigint('FinishedAt');
      t.string('Status', 16).notNull();
      t.json('Error');
    });

    await connection.schema().createTable('__scheduler_run_step', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('RunId', 36).notNull();
      t.int('Attempt').notNull();
      t.int('Seq').notNull();
      t.string('Name', 128).notNull();
      t.string('Status', 16).notNull();
      t.int('Weight').notNull();
      t.bigint('StartedAt').notNull();
      t.bigint('FinishedAt');
      t.int('Progress').notNull();
      t.int('Done');
      t.int('Total');
      t.text('Message');
      t.json('Result');
      t.json('Error');
    });

    await connection.schema().createTable('__scheduler_run_log', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('RunId', 36).notNull();
      t.string('Schedule', 128).notNull();
      t.int('Seq').notNull();
      t.int('Attempt').notNull();
      t.bigint('Ts').notNull();
      t.string('Kind', 16).notNull();
      t.string('Level', 8);
      t.string('Step', 128);
      t.text('Message');
      t.json('Data');
      t.int('Pos').notNull();
    });

    // One row; appendJournalRow() bumps it in the insert's transaction (R15).
    await connection.schema().createTable('__scheduler_journal_pos', (t) => {
      t.int('Id').primaryKey().notNull();
      t.bigint('LastPos').notNull();
    });
    await connection.insert().into('__scheduler_journal_pos').values({ Id: 1, LastPos: 0 });

    await connection.schema().createTable('__scheduler_error', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Schedule', 128).notNull();
      t.string('Fingerprint', 64).notNull();
      t.string('Name', 128).notNull();
      t.text('SampleMessage').notNull();
      t.text('SampleStack');
      t.int('Count').notNull();
      t.bigint('FirstSeen').notNull();
      t.bigint('LastSeen').notNull();
      t.string('LastRunId', 36);
      t.string('Status', 16).notNull();
    });

    await connection.index().table('__scheduler').name('__scheduler_due').columns(['Paused', 'NextRunAt']);
    await connection.index().table('__scheduler_run').name('__scheduler_run_status').columns(['Status', 'NextAttemptAt']);
    await connection.index().table('__scheduler_run').name('__scheduler_run_schedule').columns(['Schedule', 'CreatedAt']);
    await connection.index().table('__scheduler_run').name('__scheduler_run_finished').columns(['FinishedAt']);
    await connection.index().table('__scheduler_run_attempt').name('__scheduler_run_attempt_run').columns(['RunId', 'Attempt']);
    await connection.index().table('__scheduler_run_step').name('__scheduler_run_step_run').columns(['RunId', 'Attempt', 'Seq']);
    await connection.index().unique().table('__scheduler_run_log').name('__scheduler_run_log_seq').columns(['RunId', 'Seq']);
    await connection.index().unique().table('__scheduler_run_log').name('__scheduler_run_log_pos').columns(['Pos']);
    await connection.index().table('__scheduler_run_log').name('__scheduler_run_log_schedule').columns(['Schedule', 'Pos']);
    await connection.index().table('__scheduler_run_log').name('__scheduler_run_log_ts').columns(['Ts']);
    await connection.index().unique().table('__scheduler_error').name('__scheduler_error_fp').columns(['Schedule', 'Fingerprint']);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}
