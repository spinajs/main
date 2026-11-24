import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Bool, BooleanValueConverter, Connection, DatetimeValueConverter, Int64ValueConverter, Json, JsonValueConverter, Model, ModelBase, Orm, Primary, Set, SetValueConverter, TimeValueConverter, UniversalValueConverter, UuidConverter, extractDecoratorPropertyDescriptor } from '@spinajs/orm';
import type { IModelDescriptor, IUniversalConverterOptions, ValueConverter } from '@spinajs/orm';
import { SqlBooleanValueConverter, SqlSetConverter } from '@spinajs/orm-sql';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { TimeSpan } from '@spinajs/util';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import '@spinajs/log';
import { SqliteDatetimeValueConverter, SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const UID = '0f9a3c2e-1b4d-4e5f-8a6b-7c8d9e0f1a2b';

function stripped(value: unknown, prefix: string): unknown {
  return typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

// A model built from data hydrates it through fromDB, so each fromDB below also takes the model's own form.
class PlainJsonConverter extends JsonValueConverter {}

class TaggedJsonConverter extends JsonValueConverter {
  public toDB(value: unknown): unknown {
    return value === null || value === undefined ? value : `json:${String(super.toDB(value))}`;
  }

  public fromDB(value: unknown): unknown {
    return super.fromDB(stripped(value, 'json:'));
  }
}

class ReversedUuidConverter extends UuidConverter {
  public toDB(value: string | Uint8Array): Uint8Array | null {
    const bytes = super.toDB(value);
    return bytes ? Buffer.from(bytes).reverse() : null;
  }

  public fromDB(value: Uint8Array | string | null | undefined): string | null {
    return super.fromDB(value instanceof Uint8Array ? Buffer.from(value).reverse() : value);
  }
}

class DayConverter extends DatetimeValueConverter {
  public toDB(value: DateTime | null): string | null {
    return value ? value.toISODate() : null;
  }

  public fromDB(value: DateTime | string | null): DateTime | null {
    return typeof value === 'string' ? DateTime.fromISO(value, { zone: 'utc' }) : value;
  }
}

class TaggedSqliteDatetimeConverter extends SqliteDatetimeValueConverter {
  public toDB(...args: Parameters<SqliteDatetimeValueConverter['toDB']>): string | number | null {
    const value = super.toDB(...args);
    return value === null ? null : `at:${String(value)}`;
  }

  public fromDB(...[value, ...rest]: Parameters<SqliteDatetimeValueConverter['fromDB']>): DateTime | null {
    return super.fromDB(stripped(value, 'at:'), ...rest);
  }
}

class YesNoConverter extends BooleanValueConverter {
  public toDB(value: boolean | null): string | null {
    return value === null || value === undefined ? null : value ? 'Y' : 'N';
  }

  public fromDB(value: boolean | string | null): boolean | null {
    return typeof value === 'string' ? value === 'Y' : value;
  }
}

class MinutesConverter extends TimeValueConverter {
  public toDB(value: TimeSpan | null): string | null {
    return value ? `${value.totalMinutes}m` : null;
  }

  public fromDB(value: TimeSpan | string | null): TimeSpan | null {
    return typeof value === 'string' ? TimeSpan.fromMinutes(parseInt(value, 10)) : value;
  }
}

class EmptyFlagConverter extends BooleanValueConverter {}

class PipeSetConverter extends SetValueConverter {
  public toDB(value: string[] | null): string | null {
    return value ? value.join('|') : null;
  }

  public fromDB(value: string[] | string | null): string[] | null {
    return typeof value === 'string' ? value.split('|') : value;
  }
}

class YesNoSqlConverter extends SqlBooleanValueConverter {
  public toDB(value: unknown): unknown {
    return value === null || value === undefined ? null : value ? 'Y' : 'N';
  }

  public fromDB(value: unknown): boolean | null {
    return typeof value === 'string' ? value === 'Y' : typeof value === 'boolean' ? value : null;
  }
}

class PipeSqlSetConverter extends SqlSetConverter {
  public toDB(value: unknown): unknown {
    return Array.isArray(value) ? value.join('|') : super.toDB(value);
  }

  public fromDB(value: string | string[] | null): string[] | null {
    return typeof value === 'string' ? value.split('|') : value;
  }
}

class TaggedInt64Converter extends Int64ValueConverter {
  public toDB(value: unknown): string | number | null {
    const converted = super.toDB(value);
    return converted === null ? null : `n:${converted}`;
  }

  public fromDB(...[value, ...rest]: Parameters<Int64ValueConverter['fromDB']>): string | number | bigint | null {
    return super.fromDB(stripped(value, 'n:'), ...rest);
  }
}

class TaggedUniversalConverter extends UniversalValueConverter {
  public toDB(...args: Parameters<UniversalValueConverter['toDB']>): unknown {
    const value: unknown = super.toDB(...args);
    return typeof value === 'string' ? `u:${value}` : value;
  }

  public fromDB(value: unknown, raw: unknown, options: IUniversalConverterOptions): unknown {
    return super.fromDB(stripped(value, 'u:'), raw, options);
  }
}

function ConvertedBy(Class: new () => ValueConverter, Options?: unknown): PropertyDecorator {
  const decorator: PropertyDecorator = extractDecoratorPropertyDescriptor((model: IModelDescriptor, _: unknown, column: string) => {
    model.Converters.set(column, { Class, Options });
  });
  return decorator;
}

@Connection('sqlite')
@Model('converter_subclass_doc')
class SubclassDoc extends ModelBase {
  @Primary()
  public Id: number;

  @Json()
  public Base: unknown;

  @ConvertedBy(PlainJsonConverter)
  public Plain: unknown;

  @ConvertedBy(TaggedJsonConverter)
  public Tagged: unknown;

  @ConvertedBy(ReversedUuidConverter)
  public Uid: string;

  @ConvertedBy(DayConverter)
  public Day: DateTime;

  @ConvertedBy(TaggedSqliteDatetimeConverter)
  public At: DateTime;

  @ConvertedBy(YesNoConverter)
  public Flag: boolean;

  @ConvertedBy(MinutesConverter)
  public Span: TimeSpan;

  @ConvertedBy(PipeSetConverter)
  public Tags: string[];

  @ConvertedBy(TaggedInt64Converter)
  public Big: string;

  public Type: string;

  @ConvertedBy(TaggedUniversalConverter, { TypeColumn: 'Type' })
  public Value: unknown;

  @ConvertedBy(YesNoSqlConverter)
  public Answer: boolean;

  @Bool()
  public Active: boolean;

  @ConvertedBy(PipeSqlSetConverter)
  public Labels: string[];

  @Set()
  public Kinds: string[];
}

@Connection('sqlite')
@Model('converter_subclass_doc')
class EmptyTokenDoc extends ModelBase {
  @Primary()
  public Id: number;

  @ConvertedBy(EmptyFlagConverter)
  public Flag: boolean;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

async function raw(id: number): Promise<Record<string, unknown>> {
  return (await driver().select().from('converter_subclass_doc').where('Id', id).first()) as Record<string, unknown>;
}

async function rejection(work: PromiseLike<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }

  throw new Error('expected the query to reject');
}

async function read(id: number): Promise<SubclassDoc> {
  return SubclassDoc.where('Id', id).first();
}

describe('sqlite: a column declaring a subclass of a shipped converter', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('converter_subclass_doc', (table) => {
        table.int('Id').primaryKey();
        table.text('Base');
        table.text('Plain');
        table.text('Tagged');
        table.binary('Uid', 16);
        table.text('Day');
        table.text('At');
        table.text('Flag');
        table.text('Span');
        table.text('Tags');
        table.text('Big');
        table.text('Type');
        table.text('Value');
        table.text('Answer');
        table.int('Active');
        table.text('Labels');
        table.text('Kinds');
      });
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  describe('JsonValueConverter', () => {
    it('a model insert and update write the JSON text of a plain subclass, which reads back as the object', async () => {
      const doc = new SubclassDoc({ Id: 1, Plain: { a: 1 } });
      await doc.insert();
      expect((await raw(1)).Plain).to.eq('{"a":1}');

      doc.Plain = { a: 2, b: [1] };
      await doc.update();
      expect((await raw(1)).Plain).to.eq('{"a":2,"b":[1]}');
      expect((await read(1)).Plain).to.deep.eq({ a: 2, b: [1] });
    });

    it('a static insert and update write the JSON text of a plain subclass', async () => {
      await SubclassDoc.insert({ Id: 2, Plain: { a: 1 } });
      expect((await raw(2)).Plain).to.eq('{"a":1}');

      await SubclassDoc.update({ Plain: { c: 'x' } }).where('Id', 2);
      expect((await raw(2)).Plain).to.eq('{"c":"x"}');
      expect((await read(2)).Plain).to.deep.eq({ c: 'x' });
    });

    it("runs the subclass's own toDB and fromDB, once per write", async () => {
      const doc = new SubclassDoc({ Id: 3, Tagged: { a: 1 } });
      await doc.insert();
      expect((await raw(3)).Tagged).to.eq('json:{"a":1}');

      doc.Tagged = { a: 2 };
      await doc.update();
      expect((await raw(3)).Tagged).to.eq('json:{"a":2}');

      await SubclassDoc.insert({ Id: 4, Tagged: [1, 2] });
      await SubclassDoc.update({ Tagged: [3] }).where('Id', 4);
      expect((await raw(4)).Tagged).to.eq('json:[3]');

      expect((await read(3)).Tagged).to.deep.eq({ a: 2 });
      expect((await read(4)).Tagged).to.deep.eq([3]);
    });

    it('reads a row that holds text which is not JSON as that text', async () => {
      await driver().insert().into('converter_subclass_doc').values({ Id: 15, Plain: '[object Object]', Tagged: 'json:hello' });

      const doc = await read(15);
      expect(doc.Plain).to.eq('[object Object]');
      expect(doc.Tagged).to.eq('hello');
    });
  });

  it('UuidConverter: a subclass runs on write and read', async () => {
    await new SubclassDoc({ Id: 5, Uid: UID }).insert();

    const stored = (await raw(5)).Uid;
    expect(Buffer.isBuffer(stored)).to.eq(true);
    expect(Buffer.from(stored as Buffer).reverse().toString('hex')).to.eq(UID.replace(/-/g, ''));
    expect((await read(5)).Uid).to.eq(UID);
  });

  it('DatetimeValueConverter: a subclass of the base class runs on write and read', async () => {
    await new SubclassDoc({ Id: 6, Day: DateTime.utc(2026, 1, 2, 3, 4, 5) }).insert();

    expect((await raw(6)).Day).to.eq('2026-01-02');
    expect((await read(6)).Day.toISO()).to.eq('2026-01-02T00:00:00.000Z');
  });

  it("DatetimeValueConverter: a subclass of the driver's implementation runs on write and read", async () => {
    const at = DateTime.utc(2026, 1, 2, 3, 4, 5, 6);
    await new SubclassDoc({ Id: 7, At: at }).insert();

    expect((await raw(7)).At).to.eq('at:2026-01-02T03:04:05.006Z');
    expect((await read(7)).At.toMillis()).to.eq(at.toMillis());
  });

  it('BooleanValueConverter: a subclass runs on write and read', async () => {
    await new SubclassDoc({ Id: 8, Flag: true }).insert();
    await SubclassDoc.insert({ Id: 9, Flag: false });

    expect((await raw(8)).Flag).to.eq('Y');
    expect((await raw(9)).Flag).to.eq('N');
    expect((await read(8)).Flag).to.eq(true);
    expect((await read(9)).Flag).to.eq(false);
  });

  it('an empty subclass of a token converter throws on write, on read and when a model is built from data', async () => {
    const onWrite = await rejection(EmptyTokenDoc.insert({ Id: 20, Flag: true }));
    expect(onWrite).to.be.instanceOf(MethodNotImplemented).with.property('message').that.contains('EmptyFlagConverter.toDB() is not implemented');

    await driver().insert().into('converter_subclass_doc').values({ Id: 21, Flag: '1' });
    const onRead = await rejection(EmptyTokenDoc.where('Id', 21).first());
    expect(onRead).to.be.instanceOf(MethodNotImplemented).with.property('message').that.contains('EmptyFlagConverter.fromDB() is not implemented');

    expect(() => new EmptyTokenDoc({ Id: 22, Flag: true })).to.throw(MethodNotImplemented, 'EmptyFlagConverter.fromDB() is not implemented');
  });

  it('TimeValueConverter: a subclass runs on write and read', async () => {
    await new SubclassDoc({ Id: 10, Span: TimeSpan.fromMinutes(90) }).insert();

    expect((await raw(10)).Span).to.eq('90m');
    expect((await read(10)).Span.totalMinutes).to.eq(90);
  });

  it('SetValueConverter: a subclass runs on write and read', async () => {
    await new SubclassDoc({ Id: 14, Tags: ['a', 'b'] }).insert();

    expect((await raw(14)).Tags).to.eq('a|b');
    expect((await read(14)).Tags).to.deep.eq(['a', 'b']);
  });

  describe("the driver's boolean and set converters", () => {
    async function ids(query: PromiseLike<SubclassDoc[]>): Promise<number[]> {
      return (await query).map((doc) => doc.Id).sort((a, b) => a - b);
    }

    it("a subclass of SqlBooleanValueConverter stores its own 'Y' / 'N' on write, on read and in a where() binding", async () => {
      const built = new SubclassDoc({ Id: 30, Answer: true });
      expect(built.Answer).to.eq(true);
      await built.insert();
      await SubclassDoc.insert({ Id: 31, Answer: false });

      expect((await raw(30)).Answer).to.eq('Y');
      expect((await raw(31)).Answer).to.eq('N');
      expect((await read(30)).Answer).to.eq(true);
      expect((await read(31)).Answer).to.eq(false);
      expect(await ids(SubclassDoc.where('Answer', true))).to.deep.eq([30]);
      expect(await ids(SubclassDoc.where('Answer', false))).to.deep.eq([31]);

      await SubclassDoc.update({ Answer: true }).where('Id', 31);
      expect((await raw(31)).Answer).to.eq('Y');
    });

    it('a subclass of SqlSetConverter runs on write, on read and in a where() binding', async () => {
      await new SubclassDoc({ Id: 32, Labels: ['a', 'b'] }).insert();
      await SubclassDoc.insert({ Id: 33, Labels: ['c'] });

      expect((await raw(32)).Labels).to.eq('a|b');
      expect((await read(32)).Labels).to.deep.eq(['a', 'b']);
      expect(await ids(SubclassDoc.where('Labels', '=', ['a', 'b']))).to.deep.eq([32]);

      await SubclassDoc.update({ Labels: ['c', 'd'] }).where('Id', 33);
      expect((await raw(33)).Labels).to.eq('c|d');
      expect((await read(33)).Labels).to.deep.eq(['c', 'd']);
    });

    it('a subclass of SqlSetConverter can read NULL as null', async () => {
      await driver().insert().into('converter_subclass_doc').values({ Id: 36, Labels: null });

      expect((await read(36)).Labels).to.eq(null);
    });

    it('@Bool() and @Set() columns still write 1 / 0 and comma-joined text', async () => {
      await new SubclassDoc({ Id: 34, Active: true, Kinds: ['x', 'y'] }).insert();
      await SubclassDoc.insert({ Id: 35, Active: false, Kinds: ['z'] });

      expect(await raw(34)).to.include({ Active: 1, Kinds: 'x,y' });
      expect(await raw(35)).to.include({ Active: 0, Kinds: 'z' });
      expect(await read(34)).to.include({ Active: true }).and.have.property('Kinds').that.deep.eq(['x', 'y']);
      expect((await read(35)).Active).to.eq(false);
      expect(await ids(SubclassDoc.where('Active', true))).to.deep.eq([34]);
    });
  });

  it('Int64ValueConverter: a subclass runs on write and read', async () => {
    await new SubclassDoc({ Id: 11, Big: '9007199254740993' }).insert();

    expect((await raw(11)).Big).to.eq('n:9007199254740993');
    expect((await read(11)).Big).to.eq('9007199254740993');
  });

  it('UniversalValueConverter: a subclass runs on write and read with its options', async () => {
    await new SubclassDoc({ Id: 12, Type: 'number', Value: 42 }).insert();

    expect((await raw(12)).Value).to.eq('u:42');
    expect((await read(12)).Value).to.eq(42);
  });

  it('a column declaring the registered class itself converts as before', async () => {
    const doc = new SubclassDoc({ Id: 13, Base: { a: 1 } });
    await doc.insert();
    doc.Base = { a: 2 };
    await doc.update();

    expect((await raw(13)).Base).to.eq('{"a":2}');
    expect((await read(13)).Base).to.deep.eq({ a: 2 });
  });
});
