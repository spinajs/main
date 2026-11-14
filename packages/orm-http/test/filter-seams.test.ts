import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { BelongsTo, Bool, Connection, DateTime as DateTimeColumn, Model, ModelBase, OrmDriver, Primary, SingleRelation } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { DateTime } from 'luxon';
import '@spinajs/log';

import '../src/extension.js';
import '../src/builders.js';
import { Filterable } from '../src/decorators.js';
import { FilterModelRouteArg } from '../src/route-arg.js';
import { FilterableLogicalOperators, IFilterRequest } from '../src/interfaces.js';
import { FilterStatics, installFilterStatics } from './filter-statics.js';

class FilterSeamsConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      // The defaults of packages/validation/src/config/validation.ts: a test configuration replaces them wholesale.
      validation: {
        allErrors: true,
        removeAdditional: false,
        useDefaults: true,
        coerceTypes: true,
        messages: false,
        strict: { idPrefixes: ['authn.', 'authz.'] },
      },
      db: {
        StrictTableCheck: false,
        DefaultConnection: 'sqlite',
        Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { Table: 'orm_migrations' } }],
      },
    };
  }
}

async function createTables(connection: OrmDriver): Promise<void> {
  await connection.schema().createTable('fseam_owner', (table) => {
    table.int('Id').primaryKey().notNull();
    table.string('Name', 16);
  });
  await connection.schema().createTable('fseam_event', (table) => {
    table.int('Id').primaryKey().notNull();
    table.string('Title', 16);
    table.dateTime('At');
    table.int('Flag');
    table.int('OwnerId');
  });

  await connection.insert().into('fseam_owner').values({ Id: 1, Name: 'alice' });
  await connection.insert().into('fseam_owner').values({ Id: 2, Name: 'bob' });
  await connection.insert().into('fseam_event').values({ Id: 1, Title: 'e1', At: '2026-01-01T00:00:00.000Z', Flag: null, OwnerId: 1 });
  await connection.insert().into('fseam_event').values({ Id: 2, Title: 'e2', At: '2026-01-05T00:00:00.000Z', Flag: 0, OwnerId: 2 });
  await connection.insert().into('fseam_event').values({ Id: 3, Title: 'e3', At: '2026-01-10T00:00:00.000Z', Flag: 1, OwnerId: 1 });
}

@Connection('sqlite')
@Model('fseam_owner')
export class FseamOwner extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(['eq'])
  public Name: string;
}

@Connection('sqlite')
@Model('fseam_event')
export class FseamEvent extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  @DateTimeColumn()
  @Filterable(['between'])
  public At: DateTime;

  @Bool({ nullable: true })
  @Filterable(['eq'])
  public Flag: boolean | null;

  public OwnerId: number;

  @BelongsTo(FseamOwner, 'OwnerId')
  @Filterable(FseamOwner)
  public Owner: SingleRelation<FseamOwner>;
}

describe('filters across the orm features they meet', function () {
  this.timeout(15000);

  let routeArg: FilterModelRouteArg;
  let events: FilterStatics<FseamEvent>;
  const param = { Name: 'filter', Options: FseamEvent, RuntimeType: Object, Type: 'FilterModelRouteArg' };

  before(async () => {
    // migrateTestDatabase() refuses a container in which an earlier suite booted the Orm
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(FilterSeamsConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Configuration);
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    const { orm } = await migrateTestDatabase();
    await createTables(orm.Connections.get('sqlite')!);
    await orm.reloadTableInfo({ models: [FseamEvent, FseamOwner] });

    events = installFilterStatics(FseamEvent);
    installFilterStatics(FseamOwner);

    routeArg = await DI.resolve(FilterModelRouteArg);
  });

  // The cache stays, as in filter-value-route.test.ts: later suites rely on the migrated Orm.
  after(() => {
    DI.unregister(FilterSeamsConfiguration);
  });

  /** Ids of the events a filter request over the route argument returns. */
  async function routeRows(filters: object[]): Promise<number[]> {
    const request = { query: { filter: JSON.stringify({ op: 'and', filters }) }, body: {} };
    const { Args } = await routeArg.extract({ Payload: {} }, [], param as any, request as any, {} as any, {} as any);
    const filterRequest = Args as IFilterRequest;
    return (await events.query(filterRequest.filters, filterRequest.op)).map((r) => r.Id).sort();
  }

  it('between on a @DateTime column takes ISO strings and returns the rows in range', async () => {
    expect(await routeRows([{ Column: 'At', Operator: 'between', Value: ['2026-01-02T00:00:00Z', '2026-01-10T00:00:00Z'] }])).to.deep.equal([2, 3]);
  });

  it('eq false on a @Bool({ nullable: true }) column returns only the false rows', async () => {
    expect(await routeRows([{ Column: 'Flag', Operator: 'eq', Value: false }])).to.deep.equal([2]);
    expect(await routeRows([{ Column: 'Flag', Operator: 'eq', Value: 'false' }])).to.deep.equal([2]);
  });

  it('a Relation.Column filter through the static Model.filter() returns owners with their own columns', async () => {
    const found = await events.filter({ op: FilterableLogicalOperators.And, filters: [{ Column: 'Owner.Name', Operator: 'eq', Value: 'alice' }] });

    expect(found.map((e) => [e.Id, e.Title]).sort()).to.deep.equal([
      [1, 'e1'],
      [3, 'e3'],
    ]);
    expect(found.every((e) => e.At instanceof DateTime && e.At.isValid)).to.eq(true);
  });
});
