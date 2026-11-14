import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** On its own logical connection; a test maps it onto the simulated file with `aliases: ['simprobe']`. */
@Migration('simprobe')
export class SimProbe_2026_11_03_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('sim_probe', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Note', 32).notNull();
    });
  }

  public down(_connection: OrmDriver): Promise<void> {
    return Promise.resolve();
  }
}
