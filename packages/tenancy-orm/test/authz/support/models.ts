import { AccessResource } from '@spinajs/authz-orm';
import { Column, Connection, Migration, Model, ModelBase, OrmMigration, Primary } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { Tenant } from '../../../src/index.js';

@Connection('default')
@Model('contract')
@Tenant()
@AccessResource('contract')
export class Contract extends ModelBase<Contract> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public tenant_id: string;

  public title: string;
}

@Migration('default')
export class TenancyAuthzTest_2026_12_01_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('contract', (table) => {
      table.int('Id').primaryKey();
      table.string('tenant_id', 64).notNull();
      table.string('title', 64).notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('contract');
  }
}
