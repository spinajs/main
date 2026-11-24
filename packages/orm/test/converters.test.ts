import { UuidConverter, StandardModelToSqlConverter, StandardObjectToSqlConverter, JsonValueConverter, Int64ValueConverter } from './../src/converters.js';
import { InvalidArgument, MethodNotImplemented } from '@spinajs/exceptions';
import { BooleanValueConverter, RelationType } from './../src/interfaces.js';
import type { IModelDescriptor } from './../src/interfaces.js';
import { OrmException } from './../src/exceptions.js';
import { hydratedKey } from './../src/column-values.js';
import { ModelBase } from './../src/model.js';
import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';

const expect = chai.expect;

function column(name: string, opts: Partial<any> = {}) {
  return {
    Name: name,
    PrimaryKey: false,
    Nullable: true,
    IsForeignKey: false,
    Virtual: false,
    Converter: null,
    ...opts,
  };
}

// Builds a minimal mock model exposing just what StandardModelToSqlConverter.toSql touches.
function mockModel(columns: any[], relations: Array<any>, values: Record<string, unknown>) {
  return {
    ModelDescriptor: {
      Columns: columns,
      Relations: new Map(relations.map((r) => [r.Name, r])),
      Converters: new Map(),
    },
    ...values,
  } as unknown as ModelBase<unknown>;
}

describe('Orm converters', () => {
  it('Should convert uuid to & from db preserving canonical dashed form ( B15b )', async () => {
    const u = '0db8f7f5-56cd-4801-ac23-ad6d78bfec3f';
    const converter = new UuidConverter();
    const uid = converter.toDB(u);

    expect(uid).to.not.be.null;
    expect(uid instanceof Buffer).to.be.true;
    expect((uid as Buffer).length).to.eq(16);

    // round-trip must be identity: fromDB rebuilds the dashed 36-char form
    const back = converter.fromDB(uid);
    expect(back).to.eq(u);
  });

  it('uuid round-trip toDB(fromDB(x)) should be identity ( B15b )', () => {
    const converter = new UuidConverter();
    const original = converter.toDB('0db8f7f5-56cd-4801-ac23-ad6d78bfec3f') as Buffer;

    // fromDB -> canonical string, toDB -> same 16-byte buffer
    const roundTripped = converter.toDB(converter.fromDB(original) as string) as Buffer;
    expect(Buffer.compare(roundTripped, original)).to.eq(0);
  });

  it('uuid fromDB(null) should return null ( B15a guard )', () => {
    const converter = new UuidConverter();
    expect(converter.fromDB(null)).to.be.null;
  });

  it('uuid toDB of the database form returns it unchanged', () => {
    const converter = new UuidConverter();
    const bytes = converter.toDB('0db8f7f5-56cd-4801-ac23-ad6d78bfec3f') as Buffer;
    const plain = new Uint8Array(bytes);

    expect(converter.toDB(bytes), 'a Buffer').to.eq(bytes);
    expect(converter.toDB(plain), 'a Uint8Array').to.eq(plain);
    expect(() => converter.toDB(Buffer.alloc(4)), 'not 16 bytes').to.throw(InvalidArgument, /16 bytes, got 4/);
  });

  describe('uuid fromDB of bytes', () => {
    const u = '0db8f7f5-56cd-4801-ac23-ad6d78bfec3f';
    const converter = new UuidConverter();
    const bytes = converter.toDB(u) as Buffer;

    it('reads a Buffer, a plain Uint8Array and a view at an offset the same way', () => {
      const larger = new Uint8Array(24);
      larger.set(bytes, 5);
      const view = larger.subarray(5, 21);

      expect(Buffer.isBuffer(view), 'the view is no Buffer').to.be.false;
      expect(view.byteOffset).to.eq(5);
      expect(converter.fromDB(bytes), 'a Buffer').to.eq(u);
      expect(converter.fromDB(new Uint8Array(bytes)), 'a Uint8Array').to.eq(u);
      expect(converter.fromDB(view), 'a view').to.eq(u);
      expect(converter.fromDB(u), 'the text form').to.eq(u);
      expect(converter.fromDB(u.replace(/-/g, '')), 'the text form without dashes').to.eq(u);
    });

    it('round-trips every value toDB returns, both ways', () => {
      const plain = new Uint8Array(bytes);
      for (const value of [u, bytes, plain]) {
        expect(converter.fromDB(converter.toDB(value)), String(value)).to.eq(u);
      }

      expect(Buffer.compare(converter.toDB(converter.fromDB(plain) as string) as Buffer, bytes)).to.eq(0);
    });

    it('returns the hex of bytes of another length, for a Uint8Array as for a Buffer', () => {
      const short = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);

      expect(converter.fromDB(Buffer.from(short)), 'a Buffer').to.eq('deadbeef');
      expect(converter.fromDB(short), 'a Uint8Array').to.eq('deadbeef');
      expect(converter.fromDB(Buffer.alloc(0)), 'an empty Buffer').to.eq('');
      expect(converter.fromDB(new Uint8Array(0)), 'an empty Uint8Array').to.eq('');
      expect(converter.fromDB(undefined), 'undefined').to.be.null;
    });
  });

  it('an empty subclass of a token converter names itself when it is asked to read', () => {
    class FlagConverter extends BooleanValueConverter {}
    const converter = new FlagConverter();
    const hint = "FlagConverter converts nothing itself; extend the driver's implementation of its base class instead, or implement both toDB() and fromDB()";

    expect(() => {
      converter.fromDB(1);
    }).to.throw(MethodNotImplemented, `FlagConverter.fromDB() is not implemented: ${hint}`);
  });

  it('int64 toDB of its own output is the same value', () => {
    const converter = new Int64ValueConverter();
    for (const value of [9007199254740993n, 42, ' 42 ']) {
      expect(converter.toDB(converter.toDB(value)), String(value)).to.eq(converter.toDB(value));
    }
  });

  it('json toDB of its own output encodes it again: a string is itself a JSON value', () => {
    const converter = new JsonValueConverter();
    expect(converter.toDB(converter.toDB({ a: 1 }))).to.eq(JSON.stringify(JSON.stringify({ a: 1 })));
  });

  describe('StandardModelToSqlConverter foreign key handling', () => {
    it('should serialize a FK column that has no backing relation', () => {
      // UserId is marked as a foreign key column but no relation manages it
      // (e.g. a plain owner-id column). It must still be serialized, otherwise
      // an INSERT would omit it and break its NOT NULL constraint.
      const model = mockModel(
        [
          column('Id', { PrimaryKey: true, Nullable: false }),
          column('Name', { Nullable: false }),
          column('UserId', { IsForeignKey: true, Nullable: false }),
        ],
        [],
        { Id: 1, Name: 'test', UserId: 42 },
      );

      const result = new StandardModelToSqlConverter().toSql(model) as Record<string, unknown>;

      expect(result).to.have.property('UserId', 42);
      expect(result).to.have.property('Name', 'test');
      expect(result).to.have.property('Id', 1);
    });

    it('should NOT serialize a FK column managed by a relation in the column loop', () => {
      // relation_id is owned by the `Relation` BelongsTo relation. It must be
      // written from the related model's primary key (via the relation loop),
      // not picked up as a plain column.
      const model = mockModel(
        [
          column('Id', { PrimaryKey: true, Nullable: false }),
          column('relation_id', { IsForeignKey: true, Nullable: true }),
        ],
        [{ Name: 'Relation', ForeignKey: 'relation_id', Type: RelationType.One, PrimaryKey: 'Id', Recursive: false }],
        {
          Id: 1,
          relation_id: 999, // raw column value, should be ignored in favor of the relation value
          // The relation joins on Relation.PrimaryKey ( 'Id' ) - the column the converter reads
          // off the target. `PrimaryKeyValue` deliberately differs, so reading it instead of the
          // join column fails this test rather than passing by coincidence.
          Relation: { Value: { Id: 7, PrimaryKeyValue: 99 } },
        },
      );

      const result = new StandardModelToSqlConverter().toSql(model) as Record<string, unknown>;

      // value comes from the related model's PK, not the raw column
      expect(result).to.have.property('relation_id', 7);
    });

    it('should serialize an unrelated FK column even when relations exist for other FKs', () => {
      const model = mockModel(
        [
          column('Id', { PrimaryKey: true, Nullable: false }),
          column('relation_id', { IsForeignKey: true, Nullable: true }),
          column('UserId', { IsForeignKey: true, Nullable: false }),
        ],
        [{ Name: 'Relation', ForeignKey: 'relation_id', Type: RelationType.One, PrimaryKey: 'Id', Recursive: false }],
        {
          Id: 1,
          relation_id: 5,
          UserId: 42,
          Relation: { Value: { Id: 5, PrimaryKeyValue: 99 } },
        },
      );

      const result = new StandardModelToSqlConverter().toSql(model) as Record<string, unknown>;

      // managed FK comes from the relation, unmanaged FK is serialized as a column
      expect(result).to.have.property('relation_id', 5);
      expect(result).to.have.property('UserId', 42);
    });

    it('passes a FK value a relation decides through the FK column converter', () => {
      const key = '0db8f7f5-56cd-4801-ac23-ad6d78bfec3f';
      const columns = [column('Id', { PrimaryKey: true, Nullable: false }), column('tag_id', { IsForeignKey: true, Converter: new UuidConverter() })];
      const relations = [{ Name: 'Tag', ForeignKey: 'tag_id', Type: RelationType.One, PrimaryKey: 'Id', Recursive: false }];
      const toSql = (values: Record<string, unknown>) => new StandardModelToSqlConverter().toSql(mockModel(columns, relations, { Id: 1, ...values })) as Record<string, unknown>;

      expect(toSql({ Tag: { Value: { Id: key } } }).tag_id, 'from the related model').to.deep.eq(new UuidConverter().toDB(key));
      expect(toSql({ tag_id: key, Tag: { Value: undefined } }).tag_id, 'from the raw column').to.deep.eq(new UuidConverter().toDB(key));
      expect(toSql({ tag_id: null, Tag: { Value: null } }), 'detached').to.have.property('tag_id', null);
    });

    it('passes the FK value of a recursive relation through the FK column converter', () => {
      const key = '0db8f7f5-56cd-4801-ac23-ad6d78bfec3f';
      const columns = [column('Id', { PrimaryKey: true, Nullable: false }), column('parent_id', { IsForeignKey: true, Converter: new UuidConverter() })];
      const relations = [{ Name: 'Children', ForeignKey: 'parent_id', Type: RelationType.Many, PrimaryKey: 'Id', Recursive: true }];

      const result = new StandardModelToSqlConverter().toSql(mockModel(columns, relations, { Id: 1, parent_id: key })) as Record<string, unknown>;

      expect(result.parent_id).to.deep.eq(new UuidConverter().toDB(key));
    });

    it('passes the key of a model under a @BelongsTo property of a plain object through the FK column converter', () => {
      const key = '0db8f7f5-56cd-4801-ac23-ad6d78bfec3f';
      const tag = Object.create(ModelBase.prototype) as ModelBase;
      Object.defineProperty(tag, 'PrimaryKeyValue', { value: key });
      const descriptor = {
        Columns: [column('Text'), column('tag_id', { IsForeignKey: true, Converter: new UuidConverter() })],
        Relations: new Map([['Tag', { Name: 'Tag', ForeignKey: 'tag_id', Type: RelationType.One, PrimaryKey: 'Id', Recursive: false }]]),
        Converters: new Map(),
      } as unknown as IModelDescriptor;

      const result = new StandardObjectToSqlConverter().toSql({ Text: 'note', Tag: tag }, descriptor) as Record<string, unknown>;

      expect(result.tag_id).to.deep.eq(new UuidConverter().toDB(key));
    });

    it('should throw when an unrelated NOT NULL FK column is null', () => {
      const model = mockModel(
        [column('Id', { PrimaryKey: true, Nullable: false }), column('UserId', { IsForeignKey: true, Nullable: false })],
        [],
        { Id: 1, UserId: null },
      );

      expect(() => new StandardModelToSqlConverter().toSql(model)).to.throw(OrmException, /UserId/);
    });

    it('should still skip virtual columns', () => {
      const model = mockModel(
        [column('Id', { PrimaryKey: true, Nullable: false }), column('Computed', { Virtual: true })],
        [],
        { Id: 1, Computed: 'should-be-ignored' },
      );

      const result = new StandardModelToSqlConverter().toSql(model) as Record<string, unknown>;

      expect(result).to.not.have.property('Computed');
    });
  });

  describe('hydratedKey of a key row an insert reported', () => {
    const uuid = '0db8f7f5-56cd-4801-ac23-ad6d78bfec3f';

    it('converts each part of a composite key with its own column converter', () => {
      const descriptor = {
        PrimaryKey: ['Id', 'Seq', 'Plain'],
        Columns: [column('Id', { PrimaryKey: true, Converter: new UuidConverter() }), column('Seq', { PrimaryKey: true, Converter: new Int64ValueConverter() }), column('Plain', { PrimaryKey: true })],
        Converters: new Map([['Seq', { Options: { as: 'bigint' } }]]),
      } as unknown as IModelDescriptor;

      expect(hydratedKey(descriptor, { Id: new UuidConverter().toDB(uuid), Seq: 7, Plain: 3 })).to.deep.eq([uuid, 7n, 3]);
    });

    it('leaves a key column without a converter, and a missing part, as they are', () => {
      const descriptor = { PrimaryKey: ['Id'], Columns: [column('Id', { PrimaryKey: true })], Converters: new Map() } as unknown as IModelDescriptor;
      const converted = { PrimaryKey: ['Id', 'Seq'], Columns: [column('Id', { PrimaryKey: true, Converter: new UuidConverter() }), column('Seq', { PrimaryKey: true, Converter: new Int64ValueConverter() })], Converters: new Map() } as unknown as IModelDescriptor;

      expect(hydratedKey(descriptor, { Id: 5 })).to.eq(5);
      expect(hydratedKey(converted, { Id: new UuidConverter().toDB(uuid) })).to.deep.eq([uuid, undefined]);
    });
  });
});
