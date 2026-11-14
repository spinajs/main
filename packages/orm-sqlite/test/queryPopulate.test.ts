import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { BelongsTo, Builder, Connection, ICompilerOutput, Model, ModelBase, Orm, Primary, Recursive, SingleRelation } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import sinon from 'sinon';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

@Connection('sqlite')
@Model('qp_target')
class QpTarget extends ModelBase {
  @Primary()
  public Id: number;

  public Label: string;
}

@Connection('sqlite')
@Model('qp_group')
class QpGroup extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public target_id: number;

  @BelongsTo(QpTarget, 'target_id', 'Id')
  public Target: SingleRelation<QpTarget>;
}

@Connection('sqlite')
@Model('qp_owner')
class QpOwner extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public target_id: number;

  public group_id: number;

  @BelongsTo(QpTarget, 'target_id', 'Id')
  public Target: SingleRelation<QpTarget>;

  @BelongsTo(QpGroup, 'group_id', 'Id')
  public Group: SingleRelation<QpGroup>;
}

@Connection('sqlite')
@Model('qp_node')
class QpNode extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public parent_id: number;

  @Recursive()
  @BelongsTo('QpNode', 'parent_id', 'Id')
  public Parent: SingleRelation<QpNode>;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

function expression(compiled: ICompilerOutput | ICompilerOutput[]): string {
  return (Array.isArray(compiled) ? compiled[0] : compiled).expression ?? '';
}

async function capture<T>(run: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const sql: string[] = [];
  const d = driver();
  const original = d.execute.bind(d);
  const stub = sinon.stub(d, 'execute').callsFake((builder: Builder<unknown>) => {
    sql.push(expression(builder.toDB()));
    const result: Promise<unknown> = original(builder);
    return result;
  });

  try {
    return { result: await run(), sql };
  } finally {
    stub.restore();
  }
}

function ownerWildcards(sql: string): number {
  return sql.split('`$QpOwner$`.*').length - 1;
}

describe('sqlite query().populate() of a belongsTo', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    const schema = () => driver().schema();
    await schema().createTable('qp_target', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Label');
    });
    await schema().createTable('qp_group', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
      t.int('target_id');
    });
    await schema().createTable('qp_owner', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
      t.int('target_id');
      t.int('group_id');
    });
    await schema().createTable('qp_node', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
      t.int('parent_id');
    });
    await db().reloadTableInfo();

    await driver().insert().into('qp_target').values([{ Id: 1, Label: 'target-1' }, { Id: 2, Label: 'target-2' }]);
    await driver().insert().into('qp_group').values([{ Id: 1, Name: 'group-1', target_id: 2 }]);
    await driver().insert().into('qp_owner').values([{ Id: 1, Name: 'owner-1', target_id: 1, group_id: 1 }, { Id: 2, Name: 'owner-2', target_id: 2, group_id: 1 }]);
    await driver().insert().into('qp_node').values([{ Id: 1, Name: 'root', parent_id: null }, { Id: 2, Name: 'leaf', parent_id: 1 }]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('query().populate() keeps the owner columns', async () => {
    const [row] = (await QpOwner.query().populate('Target'));

    expect(row.Name).to.equal('owner-1');
    expect(row.Target.Value?.Label).to.equal('target-1');
  });

  it('query().populate().orderBy() sorts by the owner column', async () => {
    const rows = (await QpOwner.query().populate('Target').orderByDescending('Id'));

    expect(rows.map((r) => r.Id)).to.deep.equal([2, 1]);
  });

  it('an explicit column list is left alone', async () => {
    const { result, sql } = await capture(async () => (await QpOwner.query().select('Id').populate('Target')));

    expect(result[0].Id).to.equal(1);
    expect(result[0].Name).to.equal(null);
    expect(ownerWildcards(sql[0])).to.equal(0);
  });

  it('a column list added after populate() is left alone too', async () => {
    const { result, sql } = await capture(async () => (await QpOwner.query().populate('Target').select('Id')));

    expect(result[0].Id).to.equal(1);
    expect(result[0].Name).to.equal(null);
    expect(ownerWildcards(sql[0])).to.equal(0);
  });

  it('a dotted where() on query() keeps the owner columns', async () => {
    const rows = (await QpOwner.query().where('Target.Label', 'target-2'));

    expect(rows).to.have.length(1);
    expect(rows[0].Name).to.equal('owner-2');
    expect(rows[0].Target.Value?.Label).to.equal('target-2');
  });

  it('two belongsTo populates select the owner columns once', async () => {
    const { result, sql } = await capture(async () => (await QpOwner.query().populate('Target').populate('Group')));

    expect(result[0].Name).to.equal('owner-1');
    expect(result[0].Target.Value?.Label).to.equal('target-1');
    expect(result[0].Group.Value?.Name).to.equal('group-1');
    expect(ownerWildcards(sql[0])).to.equal(1);
  });

  it('a nested belongsTo populate selects the owner columns once', async () => {
    const { result, sql } = await capture(async () => (await QpOwner.query().populate('Group.Target')));

    expect(result[0].Name).to.equal('owner-1');
    expect(result[0].Group.Value?.Name).to.equal('group-1');
    expect(result[0].Group.Value?.Target.Value?.Label).to.equal('target-2');
    expect(ownerWildcards(sql[0])).to.equal(1);
  });

  it('select().populate() is unchanged', async () => {
    const { result, sql } = await capture(async () => (await QpOwner.select().populate('Target')));

    expect(result[0].Name).to.equal('owner-1');
    expect(ownerWildcards(sql[0])).to.equal(1);
  });

  it('first() on query().populate() returns a full owner', async () => {
    const row = (await QpOwner.query().populate('Target').first());

    expect(row.Name).to.equal('owner-1');
    expect(row.Target.Value?.Label).to.equal('target-1');
  });

  it('selectCount() on query().populate() still counts the owners', async () => {
    const count = await QpOwner.query().populate('Target').selectCount();

    expect(count).to.equal(2);
  });

  // Compiled, not run: the recursive CTE itself fails on sqlite for select() as well
  // ( "multiple references to recursive table" ), independently of the owner columns.
  it('query().populate() of a recursive belongsTo keeps the owner columns', () => {
    expect(expression(QpNode.query().populate('Parent').toDB())).to.match(/^SELECT \* FROM `qp_node`/);
  });
});
