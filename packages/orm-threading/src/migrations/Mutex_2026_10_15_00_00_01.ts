/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/**
 * Before this release every replica shared the tenant `app.name` and `@Task` never released
 * its mutex, so `task-*` rows stay locked under a tenant that per-process identities never
 * match again. Old replicas never excluded each other anyway, so dropping their locks loses
 * no guarantee.
 */
@Migration('default')
export class Mutex_2026_10_15_00_00_01 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.update().in('__mutex__').update({ Locked: false }).where({ Locked: true });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}
