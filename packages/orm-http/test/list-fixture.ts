import AjvModule from 'ajv';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { BelongsTo, Connection, Migration, Model, ModelBase, OrmDriver, OrmMigration, Primary, SingleRelation } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import '@spinajs/log';

import { TestConfiguration } from './common.js';
import '../src/extension.js';
import '../src/builders.js';
import { Filterable, Sortable } from '../src/decorators.js';
import { installFilterStatics } from './filter-statics.js';

@Migration('default')
export class ListQueries_2026_11_13_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('lq_customer', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Name', 64).notNull();
    });
    await connection.schema().createTable('lq_order', (table) => {
      table.int('Id').primaryKey().notNull();
      table.int('CustomerId').notNull();
      table.string('Status', 16).notNull();
      table.int('Amount').notNull();
      table.string('Note', 64);
    });

    await connection.insert().into('lq_customer').values({ Id: 1, Name: 'acme' });
    await connection.insert().into('lq_customer').values({ Id: 2, Name: 'bolt' });
    await connection.insert().into('lq_customer').values({ Id: 3, Name: 'core' });

    await connection.insert().into('lq_order').values({ Id: 1, CustomerId: 1, Status: 'open', Amount: 100, Note: 'urgent delivery' });
    await connection.insert().into('lq_order').values({ Id: 2, CustomerId: 1, Status: 'paid', Amount: 250, Note: null });
    await connection.insert().into('lq_order').values({ Id: 3, CustomerId: 2, Status: 'open', Amount: 40, Note: '' });
    await connection.insert().into('lq_order').values({ Id: 4, CustomerId: 2, Status: 'open', Amount: 60, Note: 'call first' });
    await connection.insert().into('lq_order').values({ Id: 5, CustomerId: 3, Status: 'paid', Amount: 500, Note: 'urgent' });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}

@Connection('default')
@Model('lq_customer')
export class Customer extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(['eq', 'like'])
  public Name: string;
}

@Connection('default')
@Model('lq_order')
export class Order extends ModelBase {
  @Primary()
  @Sortable()
  @Filterable(['eq', 'in'])
  public Id: number;

  @Filterable(['eq', 'in'])
  public CustomerId: number;

  @Sortable()
  @Filterable(['eq', 'neq', 'in'])
  public Status: string;

  @Sortable()
  @Filterable(['eq', 'gt', 'gte', 'lt', 'lte'])
  public Amount: number;

  @Filterable(['like', 'nlike', 'b-like', 'nb-like', 'e-like', 'ne-like', 'empty', 'nempty', 'isnull'])
  public Note: string;

  @BelongsTo(Customer, 'CustomerId')
  public Customer: SingleRelation<Customer>;
}

export const LIST_MODELS = [Order, Customer];

/** Boots the ORM on SQLite in memory with the fixture migrated and orm-http's statics installed. */
export async function bootListFixture(): Promise<void> {
  // migrateTestDatabase() refuses a container in which an earlier suite booted the Orm
  DI.clearCache();
  DI.setESMModuleSupport();
  DI.register(TestConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }
  await migrateTestDatabase();

  for (const model of LIST_MODELS) {
    installFilterStatics(model);
  }
}

export const idsOf = (rows: { Id: number }[]): number[] => rows.map((row) => row.Id).sort((a, b) => a - b);

const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new () => { compile(schema: object): (data: unknown) => boolean };

/** A validator of `schema`, compiled as a client of the generated schema would. */
export const compileSchema = (schema: object): ((data: unknown) => boolean) => new Ajv().compile(schema);
