import { Column, Connection, Migration, Model, ModelBase, OrmMigration, Primary } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { Tenant } from '../../../src/index.js';

@Connection('lc')
@Model('lc_customer')
@Tenant()
export class LcCustomer extends ModelBase<LcCustomer> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public tenant_id: string;

  public name: string;
}

@Migration('lc')
export class LcTables_2026_12_01_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('lc_customer', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('tenant_id', 64).notNull();
      t.string('name', 64).notNull();
    });
  }

  public down(): Promise<void> {
    return Promise.resolve();
  }
}
