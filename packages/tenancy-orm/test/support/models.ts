import { BelongsTo, Column, Connection, HasMany, Migration, Model, ModelBase, OrmMigration, Primary, Recursive, Relation, SingleRelation } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { Tenant } from '../../src/index.js';

@Connection('default')
@Model('carrier')
export class Carrier extends ModelBase<Carrier> {
  @Primary()
  public Id: number;

  public name: string;
}

@Connection('default')
@Model('invoice_line')
@Tenant()
export class InvoiceLine extends ModelBase<InvoiceLine> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public tenant_id: string;

  public invoice_id: number;

  public sku: string;
}

@Connection('default')
@Model('invoice')
@Tenant()
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public tenant_id: string;

  public code: string;

  public status: string;

  public carrier_id: number | null;

  @BelongsTo(Carrier, 'carrier_id')
  public Carrier: SingleRelation<Carrier>;

  @HasMany(InvoiceLine, { foreignKey: 'invoice_id', primaryKey: 'Id' })
  public Lines: Relation<InvoiceLine, Invoice>;
}

@Connection('default')
@Model('note')
@Tenant({ column: 'org' })
export class Note extends ModelBase<Note> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public org: string;

  public body: string;
}

// Its table has no tenant column.
@Connection('default')
@Model('orphan')
@Tenant()
export class Orphan extends ModelBase<Orphan> {
  @Primary()
  public Id: number;

  public label: string;
}

// Not a tenant model, on a tenant table.
@Connection('default')
@Model('invoice')
export class InvoiceView extends ModelBase<InvoiceView> {
  @Primary()
  public Id: number;

  public code: string;
}

@Connection('default')
@Model('folder')
@Tenant()
export class Folder extends ModelBase<Folder> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public tenant_id: string;

  public name: string;

  public parent_id: number | null;

  @Recursive()
  @BelongsTo(Folder, 'parent_id')
  public Parent: SingleRelation<Folder>;
}

// A subclass of a tenant model with a table of its own.
@Connection('default')
@Model('archived_note')
export class ArchivedNote extends Note {}

// No table of its own: the tables of its subclasses are tenant tables.
@Tenant()
export abstract class TenantOwned<M = unknown> extends ModelBase<M> {
  @Column({ family: 'text', length: 64 })
  public tenant_id: string;
}

@Connection('default')
@Model('ledger')
export class Ledger extends TenantOwned<Ledger> {
  @Primary()
  public Id: number;

  public entry: string;
}

const TABLES = ['carrier', 'invoice', 'invoice_line', 'note', 'orphan', 'archived_note', 'ledger', 'folder'];

@Migration('default')
export class TenancyOrmTest_2026_11_16_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('carrier', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('name', 64).notNull();
    });
    await connection.schema().createTable('invoice', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('tenant_id', 64).notNull();
      table.string('code', 32).notNull();
      table.string('status', 16).notNull();
      table.int('carrier_id');
    });
    await connection.schema().createTable('invoice_line', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('tenant_id', 64).notNull();
      table.int('invoice_id').notNull();
      table.string('sku', 32).notNull();
    });
    await connection.schema().createTable('note', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('org', 64).notNull();
      table.string('body', 200).notNull();
    });
    await connection.schema().createTable('orphan', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('label', 32).notNull();
    });
    await connection.schema().createTable('archived_note', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('org', 64).notNull();
      table.string('body', 200).notNull();
    });
    await connection.schema().createTable('ledger', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('tenant_id', 64).notNull();
      table.string('entry', 32).notNull();
    });
    await connection.schema().createTable('folder', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('tenant_id', 64).notNull();
      table.string('name', 32).notNull();
      table.int('parent_id');
    });
    await connection.index().table('invoice').name('invoice_tenant').columns(['tenant_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    for (const table of TABLES) await connection.schema().dropTable(table);
  }
}
