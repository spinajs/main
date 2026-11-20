import { DI } from '@spinajs/di';
import { InStatement } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, UowOrder } from './uowFixture.js';

function inStatementOf(query: { Statements: unknown[] }): InStatement {
  const found = query.Statements.find((s) => s instanceof InStatement);
  if (!(found instanceof InStatement)) throw new Error('the query has no IN statement');
  return found;
}

describe('InStatement accessors', function () {
  this.timeout(30000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
  });

  afterEach(() => DI.clearCache());

  it('reads the column, the values and the negation of whereIn() and whereNotIn()', () => {
    const included = inStatementOf(UowOrder.query().whereIn('Id', [1, 2]));
    expect(included.Column).to.equal('Id');
    expect(included.Values).to.deep.equal([1, 2]);
    expect(included.Not).to.equal(false);

    const excluded = inStatementOf(UowOrder.query().whereNotIn('Id', [3]));
    expect(excluded.Values).to.deep.equal([3]);
    expect(excluded.Not).to.equal(true);
  });
});
