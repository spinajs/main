import { UuidConverter, StandardModelToSqlConverter, JsonValueConverter, Int64ValueConverter } from './../src/converters.js';
import { InvalidArgument } from '@spinajs/exceptions';
import { RelationType } from './../src/interfaces.js';
import { OrmException } from './../src/exceptions.js';
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
    const back = converter.fromDB(uid as Buffer);
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
    expect(converter.fromDB(null as any)).to.be.null;
  });

  it('uuid toDB of the database form returns it unchanged', () => {
    const converter = new UuidConverter();
    const bytes = converter.toDB('0db8f7f5-56cd-4801-ac23-ad6d78bfec3f') as Buffer;
    const plain = new Uint8Array(bytes);

    expect(converter.toDB(bytes), 'a Buffer').to.eq(bytes);
    expect(converter.toDB(plain), 'a Uint8Array').to.eq(plain);
    expect(() => converter.toDB(Buffer.alloc(4)), 'not 16 bytes').to.throw(InvalidArgument, /16 bytes, got 4/);
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
});
