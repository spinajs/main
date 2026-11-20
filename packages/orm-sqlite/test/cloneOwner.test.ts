import { DI } from '@spinajs/di';
import { ManyToManyRelation, SelectQueryBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import './migrations/TestMigration_2022_02_08_01_13_00.js';
import { bootUow, registerUowConnection, UowOrder, UowOrderItem } from './uowFixture.js';

function select(query: unknown): SelectQueryBuilder {
  if (!(query instanceof SelectQueryBuilder)) throw new Error('not a select builder');
  return query;
}

function manyToMany(relation: unknown): ManyToManyRelation {
  if (!(relation instanceof ManyToManyRelation)) throw new Error('not a many-to-many relation');
  return relation;
}

describe('SelectQueryBuilder.clone() and the owner relation', function () {
  this.timeout(30000);

  before(() => {
    registerUowConnection();
  });

  beforeEach(async () => {
    await bootUow();
  });

  afterEach(() => DI.clearCache());

  it('keeps the owner of its source when none is given', () => {
    let inner: unknown;
    const keep = (builder: unknown): void => {
      inner = builder;
    };
    void UowOrderItem.query().populate('Order', function () {
      keep(this);
    });
    const relationQuery = select(inner);

    expect(relationQuery.Owner).to.not.equal(undefined);
    expect(relationQuery.clone().Owner).to.equal(relationQuery.Owner);
  });

  it('is owned by the relation it is handed', () => {
    const [relation] = UowOrderItem.query().populate('Order').Relations;

    expect(select(UowOrderItem.where('Id', 1).clone(relation)).Owner).to.equal(relation);
  });

  it('a clone of a populated query owns the junction query of its many-to-many relation copy', () => {
    const query = UowOrder.query().populate('Tags');
    const source = manyToMany(query.Relations[0]);
    const copy = manyToMany(query.clone().Relations[0]);

    const joinQuery = select(copy.TableJoinQuery);
    expect(joinQuery.Owner).to.equal(copy);
    expect(joinQuery.Owner).to.not.equal(source);
  });

  it('a clone of a populated query owns the relation query of its relation copy', () => {
    const query = UowOrder.query().populate('Tags');
    const source = manyToMany(query.Relations[0]);
    const copy = manyToMany(query.clone().Relations[0]);

    const relationQuery = select(copy.RelationQuery);
    expect(relationQuery.Owner).to.equal(copy);
    expect(relationQuery.Owner).to.not.equal(source);
  });
});
