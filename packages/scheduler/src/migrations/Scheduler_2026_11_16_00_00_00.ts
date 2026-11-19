import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** The W3C traceparent of each attempt's run span, so a retry or a resume can link to the attempt it continues. */
@Migration('default')
export class Scheduler_2026_11_16_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__scheduler_run_attempt', (t) => {
      t.string('TraceParent', 55);
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__scheduler_run_attempt', (t) => {
      t.dropColumn('TraceParent');
    });
  }
}
