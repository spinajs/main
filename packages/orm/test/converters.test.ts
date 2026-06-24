import { UuidConverter, StandardModelToSqlConverter } from './../src/converters.js';
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
  it('Should convert uuid to & from db', async () => {
    const u = '0db8f7f5-56cd-4801-ac23-ad6d78bfec3f';
    const converter = new UuidConverter();
    const uid = converter.toDB(u);

    expect(uid).to.not.be.null;
    expect(uid instanceof Buffer).to.be.true;
    expect((uid as Buffer).length).to.eq(16);

    const back = converter.fromDB(uid as Buffer);
    expect(back === u.replace(/-/g, '')).to.be.true;
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
        [{ Name: 'Relation', ForeignKey: 'relation_id', Type: RelationType.One, Recursive: false }],
        {
          Id: 1,
          relation_id: 999, // raw column value, should be ignored in favor of the relation value
          Relation: { Value: { PrimaryKeyValue: 7 } },
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
        [{ Name: 'Relation', ForeignKey: 'relation_id', Type: RelationType.One, Recursive: false }],
        {
          Id: 1,
          relation_id: 5,
          UserId: 42,
          Relation: { Value: { PrimaryKeyValue: 5 } },
        },
      );

      const result = new StandardModelToSqlConverter().toSql(model) as Record<string, unknown>;

      // managed FK comes from the relation, unmanaged FK is serialized as a column
      expect(result).to.have.property('relation_id', 5);
      expect(result).to.have.property('UserId', 42);
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
