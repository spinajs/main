import { DI } from '@spinajs/di';
import { SelectQueryBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import './migrations/TestMigration_2022_02_08_01_13_00.js';
import { bootUow, registerUowConnection, UowOrderItem } from './uowFixture.js';

function select(query: unknown): SelectQueryBuilder {
  if (!(query instanceof SelectQueryBuilder)) throw new Error('not a select builder');
  return query;
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
});
