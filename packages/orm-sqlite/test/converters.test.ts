/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { ModelBase, RelationType, OrmException } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import { SqliteModelToSqlConverter } from './../src/converters.js';

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

// Builds a minimal mock model exposing just what SqliteModelToSqlConverter.toSql touches.
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

describe('SqliteModelToSqlConverter foreign key handling', () => {
  it('should serialize a FK column that has no backing relation', () => {
    // UserId is a foreign-key column but no relation manages it. It must still
    // be serialized, otherwise an INSERT omits it and breaks its NOT NULL constraint.
    const model = mockModel(
      [
        column('Id', { PrimaryKey: true, Nullable: false }),
        column('Name', { Nullable: false }),
        column('UserId', { IsForeignKey: true, Nullable: false }),
      ],
      [],
      { Id: 1, Name: 'test', UserId: 42 },
    );

    const result = new SqliteModelToSqlConverter().toSql(model) as Record<string, unknown>;

    expect(result).to.have.property('UserId', 42);
    expect(result).to.have.property('Name', 'test');
    expect(result).to.have.property('Id', 1);
  });

  it('should NOT serialize a FK column managed by a relation in the column loop', () => {
    const model = mockModel(
      [
        column('Id', { PrimaryKey: true, Nullable: false }),
        column('relation_id', { IsForeignKey: true, Nullable: true }),
      ],
      [{ Name: 'Relation', ForeignKey: 'relation_id', Type: RelationType.One, Recursive: false }],
      {
        Id: 1,
        relation_id: 999, // raw column value, ignored in favor of the relation value
        Relation: { Value: { PrimaryKeyValue: 7 } },
      },
    );

    const result = new SqliteModelToSqlConverter().toSql(model) as Record<string, unknown>;

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

    const result = new SqliteModelToSqlConverter().toSql(model) as Record<string, unknown>;

    expect(result).to.have.property('relation_id', 5);
    expect(result).to.have.property('UserId', 42);
  });

  it('should throw when an unrelated NOT NULL FK column is null', () => {
    const model = mockModel(
      [column('Id', { PrimaryKey: true, Nullable: false }), column('UserId', { IsForeignKey: true, Nullable: false })],
      [],
      { Id: 1, UserId: null },
    );

    expect(() => new SqliteModelToSqlConverter().toSql(model)).to.throw(OrmException, /UserId/);
  });

  it('should omit an unrelated nullable FK column when its value is undefined', () => {
    // sqlite omits undefined values so the DB default is used (sqlite has no
    // DEFAULT keyword support in insert statements).
    const model = mockModel(
      [column('Id', { PrimaryKey: true, Nullable: false }), column('UserId', { IsForeignKey: true, Nullable: true })],
      [],
      { Id: 1, UserId: undefined },
    );

    const result = new SqliteModelToSqlConverter().toSql(model) as Record<string, unknown>;

    expect(result).to.not.have.property('UserId');
  });
});
