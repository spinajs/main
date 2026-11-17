import { expect } from 'chai';
import 'mocha';
import { JoinStatement, Model, ModelBase, RawQuery } from '../src/index.js';
import type { IQueryStatementResult } from '../src/index.js';

@Model('ward_table')
class Ward extends ModelBase {}

class TestJoin extends JoinStatement {
  public clone(): TestJoin {
    return this;
  }

  public build(): IQueryStatementResult {
    return { Bindings: [], Statements: [] };
  }
}

describe('JoinStatement.Joined', () => {
  it('names the joined table, the alias its columns are read under, and the model', () => {
    expect(new TestJoin({ joinModel: Ward }).Joined).to.deep.eq({ table: 'ward_table', alias: 'Ward', model: Ward });
    expect(new TestJoin({ joinModel: Ward, joinTableAlias: 'w' }).Joined).to.deep.eq({ table: 'ward_table', alias: 'w', model: Ward });
    expect(new TestJoin({ joinTable: 'bed', joinTableAlias: 'b' }).Joined).to.deep.eq({ table: 'bed', alias: 'b', model: undefined });
  });

  it('names nothing for a raw join', () => {
    expect(new TestJoin({ query: RawQuery.create('LEFT JOIN bed ON 1 = 1') }).Joined).to.deep.eq({ table: undefined, alias: undefined, model: undefined });
  });
});
