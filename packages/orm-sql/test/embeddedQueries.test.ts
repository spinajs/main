import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { BelongsTo, Connection, Model, ModelBase, Orm, Primary, RawQuery, SelectQueryBuilder } from '@spinajs/orm';
import type { SingleRelation } from '@spinajs/orm';
import type { IQueryStatement } from '@spinajs/orm';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { JoinModel } from './Models/JoinModel.js';
import { Model3 } from './Models/Model3.js';
import { Model4 } from './Models/Model4.js';
import { RelationModel } from './Models/RelationModel.js';
import { RelationModel2 } from './Models/RelationModel2.js';
import { RelationModel3 } from './Models/RelationModel3.js';

/** Every select the statements hold as a sub-query, depth first, through `SubQuery` and `nested()` only. */
function embedded(statements: readonly IQueryStatement[]): SelectQueryBuilder[] {
  return statements.flatMap((s) => [...(s.SubQuery === undefined ? [] : [s.SubQuery]), ...embedded(s.nested?.() ?? [])]);
}

function asSelect(query: unknown): SelectQueryBuilder {
  if (!(query instanceof SelectQueryBuilder)) throw new Error('not a select builder');
  return query;
}

const ids = () => RelationModel2.query();

// The exists handler of a belongsTo checks its foreign key on the outer model; the fixture's models declare none.
@Connection('sqlite')
@Model('embedded_child')
class Child extends ModelBase {
  @Primary()
  public Id: number;

  @BelongsTo(RelationModel2, 'Id', 'Id')
  public Parent: SingleRelation<RelationModel2>;
}

describe('statements expose the selects embedded in them', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('whereIn, whereNotIn, whereExist and whereNotExists with a query hold that query', () => {
    const subs = [ids(), ids(), ids(), ids()];
    const query = RelationModel.query().whereIn('relation_id', subs[0]).whereNotIn('relation_id', subs[1]).whereExist(subs[2]).whereNotExists(subs[3]);

    expect(embedded(query.Statements)).to.have.ordered.members(subs);
  });

  it('whereExist of a belongsTo, a hasMany and a many-to-many relation holds the target or the junction select', () => {
    const belongsTo = embedded(
      Child.query().whereExist('Parent', function () {
        this.whereNotNull('Id');
      }).Statements,
    );
    const hasMany = embedded(Model3.query().whereExist('Model4s').Statements);
    const manyToMany = embedded(RelationModel3.query().whereExist('Models').Statements);

    expect(belongsTo.map((q) => q.Model)).to.deep.equal([RelationModel2]);
    expect(hasMany.map((q) => q.Model)).to.deep.equal([Model4]);
    expect(manyToMany.map((q) => q.Model)).to.deep.equal([JoinModel]);
  });

  it('a nested group, and a sub-query inside a sub-query, are reached through nested() and SubQuery', () => {
    const inner = ids();
    const middle = Model4.query().whereIn('Bar', inner);
    const query = RelationModel.query().where(function () {
      this.where('Id', 1).orWhere(function () {
        this.whereIn('relation_id', middle);
      });
    });

    expect(embedded(query.Statements)).to.have.ordered.members([middle]);
    expect(embedded(middle.Statements)).to.have.ordered.members([inner]);
  });

  it('a join callback holds its sub-query in nested()', () => {
    const sub = ids();
    const query = RelationModel.query().leftJoin('Relation', function () {
      this.whereIn('Id', sub);
    });

    expect(embedded(query.JoinStatements)).to.have.ordered.members([sub]);
  });

  it('a condition column holds its sub-query in nested()', () => {
    const sub = ids();
    const query = asSelect(RelationModel.query().select('*')).selectCondition('Linked', function () {
      this.whereIn('relation_id', sub);
    });

    expect(embedded(query.getColumns())).to.have.ordered.members([sub]);
  });

  it('a to-one populate names its query until it compiled, then the owner holds the sub-queries in its join and its conditions', () => {
    const onJoin = ids();
    const narrowing = ids();
    const query = RelationModel.query().populate('Relation', function () {
      this.whereIn('Id', narrowing).whereOnJoin(function () {
        this.whereIn('Id', onJoin);
      });
    });
    const relation = query.Relations[0];
    const pending = asSelect(relation.pendingQuery?.());

    expect(pending.Model).to.equal(RelationModel2);
    expect(embedded(pending.Statements)).to.have.ordered.members([narrowing, onJoin]);

    query.toDB();

    expect(relation.pendingQuery?.()).to.equal(undefined);
    expect(embedded(query.JoinStatements)).to.have.ordered.members([onJoin]);
    expect(embedded(query.Statements)).to.have.ordered.members([narrowing]);
  });

  it('update and delete statements hold the sub-queries of their conditions', () => {
    const forUpdate = ids();
    const forDelete = ids();

    expect(embedded(RelationModel.update({ Id: 1 }).whereIn('relation_id', forUpdate).Statements)).to.have.ordered.members([forUpdate]);
    expect(embedded(RelationModel.destroy().whereIn('relation_id', forDelete).Statements)).to.have.ordered.members([forDelete]);
  });

  it('a statement without a builder holds nothing, and a relation that runs its own query has no pending one', () => {
    const query = Model3.query()
      .where('Id', 1)
      .whereIn('Id', [1, 2])
      .whereNull('Id')
      .where(new RawQuery('1 = 1'))
      .populate('Model4s');

    expect(query.Statements.map((s) => [s.SubQuery, s.nested?.()])).to.deep.equal([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(query.Relations[0].pendingQuery?.()).to.equal(undefined);
  });
});
