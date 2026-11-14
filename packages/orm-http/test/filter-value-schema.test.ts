/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Connection, IColumnDescriptor, IModelDescriptor, ISelectQueryBuilder, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { DataValidator } from '@spinajs/validation';
import '@spinajs/orm-sqlite';
import '@spinajs/log';

// Declares IModelDescriptor.FilterableColumns and installs `filter()` on SelectQueryBuilder.
import '../src/extension.js';
import '../src/builders.js';
import { Filterable } from '../src/decorators.js';
import { FILTER_OPERATOR_GROUPS, filterSchemaFor, MODEL_STATIC_MIXINS } from '../src/model.js';
import { FilterableOperators, IColumnFilter } from '../src/interfaces.js';

class FilterValueSchemaConfiguration extends FrameworkConfiguration {
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

@Connection('sqlite')
@Model('filter_value_schema_author')
class FvsAuthor extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(['eq', 'in'])
  public Name: string;
}

@Connection('sqlite')
@Model('filter_value_schema_book')
class FvsBook extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable({ operators: ['eq', 'in', 'between'], value: { type: 'string', enum: ['draft', 'published'] } })
  public State: string;

  @Filterable(FvsAuthor)
  public Author: unknown;
}

function column(Name: string, Type: string, extra: Partial<IColumnDescriptor> = {}): IColumnDescriptor {
  return { Name, Type, NativeType: Type, MaxLength: 0, Comment: '', Nullable: true, Virtual: false, Ignore: false, Converter: null, ...extra } as unknown as IColumnDescriptor;
}

/** A descriptor as the orm leaves it after reading SQLite table info: integer N first, so it is tried first. */
function descriptor(): IModelDescriptor {
  return {
    Name: 'Row',
    Columns: [column('N', 'INTEGER'), column('F', 'REAL'), column('S', 'TEXT'), column('B', 'BOOLEAN'), column('Tags', 'set'), column('search', undefined as unknown as string, { Virtual: true })],
    Converters: new Map(),
    Relations: new Map(),
  } as unknown as IModelDescriptor;
}

const ALL: IColumnFilter<unknown>['operators'] = Object.keys(FILTER_OPERATOR_GROUPS) as IColumnFilter<unknown>['operators'];

function columns(): IColumnFilter<unknown>[] {
  return [
    { column: 'N', operators: ALL },
    { column: 'F', operators: ['gte', 'between'] },
    { column: 'S', operators: ['eq', 'in', 'like'] },
    { column: 'B', operators: ['eq'] },
    { column: 'Tags', operators: ['in-set'] },
    { column: 'search', operators: ['like'] },
    { column: 'Custom', operators: ['eq', 'isnull'], query: () => function () {} },
  ];
}

describe('orm-http filter schema checks each value against its operator and column', function () {
  this.timeout(15000);

  let validator: DataValidator;
  let schema: object;
  let orm: Orm;

  before(async () => {
    // migrateTestDatabase() refuses a container in which an earlier suite booted the Orm
    DI.clearCache();
    DI.register(FilterValueSchemaConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    // migrations other suites of this package declare are pending otherwise, and the boot guard refuses them
    ({ orm } = await migrateTestDatabase());
    validator = await DI.resolve(DataValidator);
    schema = filterSchemaFor(columns(), descriptor());

    for (const model of [FvsAuthor, FvsBook]) {
      for (const mixin in MODEL_STATIC_MIXINS) {
        (model as any)[mixin] = (MODEL_STATIC_MIXINS as any)[mixin].bind(model);
      }
    }
  });

  // The cache stays: filters.test.ts resolves the Orm without migrating, and relies on the migrated Orm and disabled
  // boot guard a previous suite leaves cached (dto-relation-resolve.test.ts did, before these suites existed).
  after(() => {
    DI.unregister(FilterValueSchemaConfiguration);
  });

  function check(filters: object[], against: object = schema): { valid: boolean; data: any } {
    const data = { op: 'and', filters };
    const [valid] = validator.tryValidate(against, data);
    return { valid, data };
  }

  function accepts(Column: string, Operator: string, Value?: unknown) {
    return check([Value === undefined ? { Column, Operator } : { Column, Operator, Value }]).valid;
  }

  describe('operator groups', () => {
    it('places every operator the builder knows in exactly one group', () => {
      let supported: string[] = [];
      try {
        (FvsAuthor.query() as ISelectQueryBuilder<unknown>).filter([{ Column: 'Name', Operator: 'no-such-operator' as FilterableOperators, Value: 1 }]);
      } catch (err) {
        supported = /Supported operators: (.*)$/.exec((err as Error).message)![1].split(', ');
      }

      expect(supported, 'the builder did not list its operators').to.not.be.empty;
      expect(Object.keys(FILTER_OPERATOR_GROUPS).sort()).to.deep.equal([...supported].sort());
    });
  });

  describe('scalar operators', () => {
    it('refuse an array for an integer and for a string column', () => {
      expect(accepts('N', 'eq', [1])).to.eq(false);
      expect(accepts('S', 'eq', ['a'])).to.eq(false);
      expect(accepts('N', 'gte', [1, 2])).to.eq(false);
    });

    it('refuse a value that is not a number for an integer column', () => {
      expect(accepts('N', 'gte', 'abc')).to.eq(false);
      expect(accepts('N', 'gte', 1.5)).to.eq(false);
    });

    it('coerce a numeric string for an integer column', () => {
      const { valid, data } = check([{ Column: 'N', Operator: 'gte', Value: '3' }]);
      expect(valid).to.eq(true);
      expect(data.filters[0].Value).to.eq(3);
    });

    it('accept a fraction for a float column', () => {
      expect(accepts('F', 'gte', 1.5)).to.eq(true);
    });

    it('require a value', () => {
      expect(accepts('N', 'eq')).to.eq(false);
    });
  });

  describe('a value is evaluated only against its own column and operator', () => {
    it('keeps a string value of a string column as sent, though an integer column is declared first', () => {
      for (const sent of ['05', '1e3']) {
        const { valid, data } = check([{ Column: 'S', Operator: 'eq', Value: sent }]);
        expect(valid, sent).to.eq(true);
        expect(data.filters[0].Value, sent).to.eq(sent);
      }
    });

    it('keeps the items of a string list as sent', () => {
      const { valid, data } = check([{ Column: 'S', Operator: 'in', Value: ['05', '1e3'] }]);
      expect(valid).to.eq(true);
      expect(data.filters[0].Value).to.deep.equal(['05', '1e3']);
    });

    it('keeps a like value as sent, inside a nested group too', () => {
      const { valid, data } = check([{ op: 'or', filters: [{ Column: 'S', Operator: 'like', Value: '05' }, { Column: 'N', Operator: 'eq', Value: '05' }] }]);
      expect(valid).to.eq(true);
      expect(data.filters[0].filters[0].Value).to.eq('05');
      expect(data.filters[0].filters[1].Value).to.eq(5);
    });
  });

  describe('text operators', () => {
    it('take a string whatever the column type', () => {
      expect(accepts('N', 'like', '12')).to.eq(true);
      expect(accepts('N', 'regexp', '^1')).to.eq(true);
      expect(accepts('S', 'like', ['a'])).to.eq(false);
    });
  });

  describe('list operators', () => {
    it('take a non-empty array of the column type', () => {
      expect(accepts('N', 'in', [1, 2])).to.eq(true);
      expect(accepts('N', 'in', [])).to.eq(false);
      expect(accepts('N', 'in', [[1]])).to.eq(false);
      expect(accepts('N', 'in', 1)).to.eq(false);
      expect(accepts('N', 'nin', ['x'])).to.eq(false);
    });

    it('take the item type of a set column', () => {
      expect(accepts('Tags', 'in-set', ['a', 'b'])).to.eq(true);
      expect(accepts('Tags', 'in-set', [['a']])).to.eq(false);
    });
  });

  describe('pair operators', () => {
    it('take exactly two values of the column type', () => {
      expect(accepts('N', 'between', [1, 2])).to.eq(true);
      expect(accepts('F', 'between', [1.5, 2.5])).to.eq(true);
      expect(accepts('N', 'between', [1])).to.eq(false);
      expect(accepts('N', 'between', [1, 2, 3])).to.eq(false);
      expect(accepts('N', 'notbetween', [1, 'x'])).to.eq(false);
    });
  });

  describe('null', () => {
    // coerceTypes would turn null into 0, false or "" and compare with that
    it('is refused for a single value of an integer, a boolean and a string column', () => {
      expect(accepts('N', 'eq', null)).to.eq(false);
      expect(accepts('B', 'eq', null)).to.eq(false);
      expect(accepts('S', 'eq', null)).to.eq(false);
    });

    it('is refused as a member of a list or a pair', () => {
      expect(accepts('N', 'in', [1, null])).to.eq(false);
      expect(accepts('N', 'between', [null, 2])).to.eq(false);
    });

    it('is refused for a column the schema knows no type of', () => {
      const untyped = filterSchemaFor([{ column: 'X', operators: ['eq'] }]);
      expect(check([{ Column: 'X', Operator: 'eq', Value: null }], untyped).valid).to.eq(false);
    });

    it('stays possible for a column with a custom query', () => {
      expect(accepts('Custom', 'eq', null)).to.eq(true);
    });
  });

  describe('valueless operators', () => {
    it('need no value', () => {
      expect(accepts('N', 'isnull')).to.eq(true);
      expect(accepts('N', 'notnull')).to.eq(true);
      expect(accepts('N', 'exists')).to.eq(true);
      expect(accepts('N', 'n-exists')).to.eq(true);
    });
  });

  describe('the scalar schema', () => {
    it('follows a boolean column', () => {
      expect(accepts('B', 'eq', true)).to.eq(true);
      expect(accepts('B', 'eq', [true])).to.eq(false);
    });

    it('is loose for a column with a custom query, which takes any value shape', () => {
      expect(accepts('Custom', 'eq', [1, 'a'])).to.eq(true);
      expect(accepts('Custom', 'eq', 'a')).to.eq(true);
      expect(accepts('Custom', 'isnull')).to.eq(true);
    });

    it('is loose for a virtual filter-only column', () => {
      expect(accepts('search', 'like', 'alp')).to.eq(true);
    });

    it('falls back to any scalar for a column the schema knows no type of', () => {
      const untyped = filterSchemaFor([{ column: 'X', operators: ['eq', 'in'] }]);
      expect(check([{ Column: 'X', Operator: 'eq', Value: 1.5 }], untyped).valid).to.eq(true);
      expect(check([{ Column: 'X', Operator: 'eq', Value: 'a' }], untyped).valid).to.eq(true);
      expect(check([{ Column: 'X', Operator: 'eq', Value: [1] }], untyped).valid).to.eq(false);
      expect(check([{ Column: 'X', Operator: 'in', Value: [1, 'a'] }], untyped).valid).to.eq(true);
      expect(check([{ Column: 'X', Operator: 'eq', Value: {} }], untyped).valid).to.eq(false);
    });

    it('keeps the JSON type of a value for a column the schema knows no type of', () => {
      const untyped = filterSchemaFor([{ column: 'X', operators: ['eq', 'in'] }]);
      for (const sent of [1, true, 'a']) {
        const { valid, data } = check([{ Column: 'X', Operator: 'eq', Value: sent }], untyped);
        expect(valid, String(sent)).to.eq(true);
        expect(data.filters[0].Value, String(sent)).to.equal(sent);
      }
      const { data } = check([{ Column: 'X', Operator: 'in', Value: [1, 'a', false] }], untyped);
      expect(data.filters[0].Value).to.deep.equal([1, 'a', false]);
    });

    it('keeps the JSON type of a value for a column with a custom query', () => {
      for (const sent of [1, true, 'a', [1, 'a']]) {
        const { valid, data } = check([{ Column: 'Custom', Operator: 'eq', Value: sent }]);
        expect(valid, String(sent)).to.eq(true);
        expect(data.filters[0].Value, String(sent)).to.deep.equal(sent);
      }
      expect(accepts('Custom', 'eq', {})).to.eq(false);
    });

    it('takes an explicit value schema first, from @Filterable options', () => {
      const book = (FvsBook as any).filterSchema();
      expect(check([{ Column: 'State', Operator: 'eq', Value: 'draft' }], book).valid).to.eq(true);
      expect(check([{ Column: 'State', Operator: 'eq', Value: 'deleted' }], book).valid).to.eq(false);
      expect(check([{ Column: 'State', Operator: 'in', Value: ['draft', 'deleted'] }], book).valid).to.eq(false);
    });

    it('takes an explicit value schema of a column list given to @Filter', () => {
      const listed = filterSchemaFor([{ column: 'Kind', operators: ['eq'], value: { type: 'integer' } }]);
      expect(check([{ Column: 'Kind', Operator: 'eq', Value: 'x' }], listed).valid).to.eq(false);
      expect(check([{ Column: 'Kind', Operator: 'eq', Value: 2 }], listed).valid).to.eq(true);
    });
  });

  describe('what the schema already refused', () => {
    it('still refuses an unknown column and a disallowed operator, inside a group too', () => {
      expect(accepts('Secret', 'eq', 1)).to.eq(false);
      expect(accepts('S', 'gt', 'a')).to.eq(false);
      expect(check([{ op: 'or', filters: [{ Column: 'S', Operator: 'gt', Value: 'a' }] }]).valid).to.eq(false);
    });
  });

  describe('@Filterable', () => {
    it('keeps the positional form and carries query and value through filterColumns()', () => {
      const book = (FvsBook as any).filterColumns() as IColumnFilter<unknown>[];
      expect(book.find((c) => c.column === 'State')).to.deep.include({ operators: ['eq', 'in', 'between'], value: { type: 'string', enum: ['draft', 'published'] } });
      expect(book.map((c) => c.column)).to.include('Author.Name');
    });
  });

  describe('strict mode', () => {
    it('compiles without a warning from the validator', () => {
      const log = (validator as any).Log;
      const warnings: string[] = [];
      const warn = log.warn;
      log.warn = (msg: unknown) => warnings.push(String(msg));
      try {
        check([{ Column: 'N', Operator: 'eq', Value: 1 }], filterSchemaFor(columns(), descriptor()));
        check([{ Column: 'X', Operator: 'eq', Value: 1 }], filterSchemaFor([{ column: 'X', operators: ['eq', 'in'] }]));
      } finally {
        log.warn = warn;
      }
      expect(warnings).to.deep.equal([]);
    });
  });

  describe('cost per request', () => {
    it('hands back the same schema object for a model while its columns stay loaded', () => {
      expect((FvsBook as any).filterSchema()).to.equal((FvsBook as any).filterSchema());
    });

    it('builds it again once the orm has read the columns again', async () => {
      const before = (FvsBook as any).filterSchema();
      await orm.reloadTableInfo({ models: [FvsBook] });
      expect((FvsBook as any).filterSchema()).to.not.equal(before);
    });
  });
});
