import { Column, Connection, Migration, Model, ModelBase, OrmMigration, Primary } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { registerTenantModel } from '../../src/index.js';
import { unregisterTenantModel } from '../../src/registry.js';

// Tenant models only between declareRlsModels() and forgetRlsModels(): other suites count the models with rls.
@Connection('rls')
@Model('rls_invoice')
export class RlsInvoice extends ModelBase<RlsInvoice> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public tenant_id: string;

  public code: string;
}

@Connection('rls')
@Model('rls_memo')
export class RlsMemo extends ModelBase<RlsMemo> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public tenant_id: string;

  public author: string;
}

@Connection('rls')
@Model('rls_placed')
export class RlsPlaced extends ModelBase<RlsPlaced> {
  @Primary()
  public Id: number;
}

@Migration('rls')
export class TenancyRlsTest_2026_11_25_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('rls_invoice', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('tenant_id', 64).notNull();
      table.string('code', 32).notNull();
    });
    await connection.schema().createTable('rls_memo', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('tenant_id', 64).notNull();
      table.string('author', 32).notNull();
    });
    await connection.schema().createTable('rls_placed', (table) => {
      table.int('Id').primaryKey().autoIncrement();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    for (const table of ['rls_placed', 'rls_memo', 'rls_invoice']) await connection.schema().dropTable(table);
  }
}

export function declareRlsModels(): void {
  registerTenantModel(RlsInvoice, { rls: true });
  registerTenantModel(RlsMemo, { rls: true });
}

export function forgetRlsModels(): void {
  unregisterTenantModel(RlsInvoice);
  unregisterTenantModel(RlsMemo);
}
