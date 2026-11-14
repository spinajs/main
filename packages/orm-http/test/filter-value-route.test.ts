/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { BelongsTo, Connection, Model, ModelBase, OrmDriver, Primary, SingleRelation } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { InvalidArgument } from '@spinajs/exceptions';
import { ValidationFailed } from '@spinajs/validation';
import '@spinajs/log';

// Declares IModelDescriptor.FilterableColumns and installs `filter()` on SelectQueryBuilder.
import '../src/extension.js';
import '../src/builders.js';
import { Filterable } from '../src/decorators.js';
import { MODEL_STATIC_MIXINS } from '../src/model.js';
import { FilterModelRouteArg } from '../src/route-arg.js';
import { IFilterRequest } from '../src/interfaces.js';

class FilterValueRouteConfiguration extends FrameworkConfiguration {
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
        // other suites of this package register models no migration creates
        StrictTableCheck: false,
        DefaultConnection: 'sqlite',
        Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { Table: 'orm_migrations' } }],
      },
    };
  }
}

// Created by the suite itself: a global @Migration would run, and leave its tables, in every other suite of the package.
async function createTables(connection: OrmDriver): Promise<void> {
  await connection.schema().createTable('fvr_owner', (table) => {
    table.int('Id').primaryKey().notNull();
    table.int('Rank');
  });
  await connection.schema().createTable('fvr_row', (table) => {
    table.int('Id').primaryKey().notNull();
    table.int('N');
    table.float('F');
    table.string('S', 16);
    // SqliteColumnCompiler declares it `INTEGER UNSIGNED`
    table.int('U').unsigned();
    table.int('OwnerId');
  });

  await connection.insert().into('fvr_owner').values({ Id: 1, Rank: 7 });
  await connection.insert().into('fvr_row').values({ Id: 1, N: 1, F: 1.25, S: '05', U: 10, OwnerId: 1 });
  await connection.insert().into('fvr_row').values({ Id: 2, N: 2, F: 2.5, S: '1e3', U: 20, OwnerId: 1 });
  await connection.insert().into('fvr_row').values({ Id: 3, N: 3, F: 3.75, S: '5', U: 30, OwnerId: 1 });
  await connection.insert().into('fvr_row').values({ Id: 4, N: null, F: null, S: 'a', U: null, OwnerId: 1 });
}

@Connection('sqlite')
@Model('fvr_owner')
export class FvrOwner extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(['eq', 'gte'])
  public Rank: number;
}

@Connection('sqlite')
@Model('fvr_row')
export class FvrRow extends ModelBase {
  @Primary()
  public Id: number;

  // declared before S, so an integer leaf would be tried first
  @Filterable(['eq', 'neq', 'gte', 'in', 'between', 'isnull'])
  public N: number;

  @Filterable(['gte'])
  public F: number;

  @Filterable(['eq', 'in', 'like'])
  public S: string;

  @Filterable(['gte'])
  public U: number;

  public OwnerId: number;

  @BelongsTo(FvrOwner, 'OwnerId')
  @Filterable(FvrOwner)
  public Owner: SingleRelation<FvrOwner>;

  @Filterable(['eq', 'between'], (_operator, value) => function (this: any) {
    this.where('N', '>=', Array.isArray(value) ? value[0] : value);
  })
  public atLeast: number;
}

describe('FilterModelRouteArg checks filter values against the operator and the column', function () {
  this.timeout(15000);

  let routeArg: FilterModelRouteArg;
  const param = { Name: 'filter', Options: FvrRow, RuntimeType: Object, Type: 'FilterModelRouteArg' } as any;

  before(async () => {
    // migrateTestDatabase() refuses a container in which an earlier suite booted the Orm
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(FilterValueRouteConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Configuration);
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    // other suites' migrations are pending otherwise, and the boot guard refuses them
    const { orm } = await migrateTestDatabase();
    await createTables(orm.Connections.get('sqlite')!);
    await orm.reloadTableInfo({ models: [FvrRow, FvrOwner] });

    for (const model of [FvrRow, FvrOwner]) {
      for (const mixin in MODEL_STATIC_MIXINS) {
        (model as any)[mixin] = (MODEL_STATIC_MIXINS as any)[mixin].bind(model);
      }
    }

    routeArg = await DI.resolve(FilterModelRouteArg);
  });

  // The cache stays: filters.test.ts resolves the Orm without migrating, and relies on the migrated Orm and disabled
  // boot guard a previous suite leaves cached (dto-relation-resolve.test.ts did, before these suites existed).
  after(() => {
    DI.unregister(FilterValueRouteConfiguration);
  });

  async function extract(filters: object[]): Promise<IFilterRequest> {
    const request = { query: { filter: JSON.stringify({ op: 'and', filters }) }, body: {} };
    const { Args } = await routeArg.extract({ Payload: {} } as any, [], param, request as any, {} as any, {} as any);
    return Args as IFilterRequest;
  }

  /** Ids of the rows a filter request returns, as the route would answer them. */
  async function rows(filters: object[]): Promise<number[]> {
    const request = await extract(filters);
    const found = (await (FvrRow.query() as any).filter(request.filters, request.op)) as FvrRow[];
    return found.map((r) => r.Id).sort();
  }

  /** The error a filter request is answered with; ValidationFailed and InvalidArgument both answer 400. */
  async function refusal(filters: object[]): Promise<Error> {
    try {
      await rows(filters);
    } catch (err) {
      return err as Error;
    }
    throw new Error(`the filter was accepted: ${JSON.stringify(filters)}`);
  }

  function expect400(err: Error) {
    expect(err instanceof ValidationFailed || err instanceof InvalidArgument, `${err.constructor.name}: ${err.message}`).to.eq(true);
  }

  it('answers 400 for an array where an operator takes one value', async () => {
    expect400(await refusal([{ Column: 'N', Operator: 'eq', Value: [1] }]));
    expect400(await refusal([{ Column: 'S', Operator: 'eq', Value: ['a'] }]));
    expect400(await refusal([{ Column: 'N', Operator: 'gte', Value: [1, 2] }]));
  });

  it('answers 400 for a nested array in a list, 200 with the rows for a flat one', async () => {
    expect400(await refusal([{ Column: 'N', Operator: 'in', Value: [[1]] }]));
    expect(await rows([{ Column: 'N', Operator: 'in', Value: [1, 2] }])).to.deep.equal([1, 2]);
  });

  it('answers 400 for a pair that does not hold two values', async () => {
    expect400(await refusal([{ Column: 'N', Operator: 'between', Value: [1] }]));
    expect400(await refusal([{ Column: 'N', Operator: 'between', Value: [1, 2, 3] }]));
  });

  it('accepts a pair of two values of the column type', async () => {
    const request = await extract([{ Column: 'N', Operator: 'between', Value: ['1', 2] }]);
    expect((request.filters![0] as any).Value).to.deep.equal([1, 2]);
  });

  it('answers 400 for a value that is no number for an integer column, coerces a numeric string', async () => {
    expect400(await refusal([{ Column: 'N', Operator: 'gte', Value: 'abc' }]));
    expect(await rows([{ Column: 'N', Operator: 'gte', Value: '3' }])).to.deep.equal([3]);
  });

  it('accepts a fraction for a float column', async () => {
    expect(await rows([{ Column: 'F', Operator: 'gte', Value: 1.5 }])).to.deep.equal([2, 3]);
  });

  it('accepts a valueless operator without a value', async () => {
    expect(await rows([{ Column: 'N', Operator: 'isnull' }])).to.deep.equal([4]);
  });

  it('matches a string column with the value as sent, though an integer column is declared first', async () => {
    expect(await rows([{ Column: 'S', Operator: 'eq', Value: '05' }])).to.deep.equal([1]);
    expect(await rows([{ Column: 'S', Operator: 'eq', Value: '1e3' }])).to.deep.equal([2]);
    expect(await rows([{ Column: 'S', Operator: 'in', Value: ['05', '1e3'] }])).to.deep.equal([1, 2]);
  });

  it('types a column copied from a related model by that model', async () => {
    expect400(await refusal([{ Column: 'Owner.Rank', Operator: 'gte', Value: 'abc' }]));
    expect400(await refusal([{ Column: 'Owner.Rank', Operator: 'eq', Value: [7] }]));
    const request = await extract([{ Column: 'Owner.Rank', Operator: 'gte', Value: '7' }]);
    expect((request.filters![0] as any).Value).to.eq(7);
  });

  it('leaves the value shape to a custom query function', async () => {
    expect(await rows([{ Column: 'atLeast', Operator: 'eq', Value: 2 }])).to.deep.equal([2, 3]);
    expect(await rows([{ Column: 'atLeast', Operator: 'between', Value: [3] }])).to.deep.equal([3]);
  });

  it('still answers 400 for an unknown column and a disallowed operator', async () => {
    expect400(await refusal([{ Column: 'Secret', Operator: 'eq', Value: 1 }]));
    expect400(await refusal([{ Column: 'F', Operator: 'eq', Value: 1 }]));
  });

  it('refuses an array for a single-value operator in filter() called from code, without the route argument', () => {
    expect(() => (FvrRow.query() as any).filter([{ Column: 'N', Operator: 'eq', Value: [1] }])).to.throw(InvalidArgument, /single value/);
    expect(() => (FvrRow.query() as any).filter([{ Column: 'N', Operator: 'gte', Value: [1, 2] }])).to.throw(InvalidArgument, /single value/);
  });

  it('types an unsigned integer column as an integer', async () => {
    expect400(await refusal([{ Column: 'U', Operator: 'gte', Value: 'abc' }]));
    expect(await rows([{ Column: 'U', Operator: 'gte', Value: '20' }])).to.deep.equal([2, 3]);
  });

  it('answers 400 for a null value, which coercion would turn into 0', async () => {
    expect400(await refusal([{ Column: 'N', Operator: 'eq', Value: null }]));
    expect400(await refusal([{ Column: 'N', Operator: 'gte', Value: null }]));
    expect400(await refusal([{ Column: 'N', Operator: 'in', Value: [1, null] }]));
    expect400(await refusal([{ Column: 'N', Operator: 'between', Value: [null, 2] }]));
  });

  // 3.0.29 behaviour from code: `where(col, '=', null)` compiles to IS NULL, `!=` to IS NOT NULL
  it('keeps eq null and neq null as IS NULL and IS NOT NULL in filter() called from code', async () => {
    const isNull = (await (FvrRow.query() as any).filter([{ Column: 'N', Operator: 'eq', Value: null }])) as FvrRow[];
    const notNull = (await (FvrRow.query() as any).filter([{ Column: 'N', Operator: 'neq', Value: null }])) as FvrRow[];

    expect(isNull.map((r) => r.Id).sort()).to.deep.equal([4]);
    expect(notNull.map((r) => r.Id).sort()).to.deep.equal([1, 2, 3]);
  });

  it('refuses null for an ordering operator in filter() called from code, as the where builder did in 3.0.29', () => {
    expect(() => (FvrRow.query() as any).filter([{ Column: 'N', Operator: 'gte', Value: null }])).to.throw(InvalidArgument, /cannot be used with null/);
  });

  it('still refuses an undefined value in filter() called from code', () => {
    expect(() => (FvrRow.query() as any).filter([{ Column: 'N', Operator: 'eq', Value: undefined }])).to.throw(InvalidArgument, /requires a value/);
  });

  it('answers 400 for eq null and neq null over the route argument', async () => {
    expect400(await refusal([{ Column: 'N', Operator: 'eq', Value: null }]));
    expect400(await refusal([{ Column: 'S', Operator: 'eq', Value: null }]));
  });
});

describe('FilterModelRouteArg with an inline column list', () => {
  // Prototype-only: extract() hands the schema to tryHydrateParam, which is replaced to capture it.
  const self = Object.create(FilterModelRouteArg.prototype) as FilterModelRouteArg;
  const schemas: unknown[] = [];
  (self as any).tryHydrateParam = async (_arg: unknown, routeParameter: { Schema: unknown }) => {
    schemas.push(routeParameter.Schema);
  };

  async function schemaFor(columns: object[]): Promise<unknown> {
    await self.extract({ Payload: {} } as any, [], { Name: 'filter', Options: columns } as any, { query: {}, body: {} } as any, {} as any, {} as any);
    return schemas[schemas.length - 1];
  }

  it('builds the schema once per list, so the validator compiles it once', async () => {
    const list = [{ column: 'Name', operators: ['eq'] }];

    expect(await schemaFor(list)).to.equal(await schemaFor(list));
    expect(await schemaFor([{ column: 'Name', operators: ['eq'] }])).to.not.equal(await schemaFor(list));
  });
});
