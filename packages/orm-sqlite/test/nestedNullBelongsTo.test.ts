/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { BelongsTo, Connection, HasMany, Json, Model, ModelBase, Orm, Primary, Relation, SingleRelation } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

@Connection('sqlite')
@Model('nnb_d')
class NnbD extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;
}

@Connection('sqlite')
@Model('nnb_c')
class NnbC extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;

  @BelongsTo(NnbD, 'd_id')
  public D: SingleRelation<NnbD>;
}

@Connection('sqlite')
@Model('nnb_item')
class NnbItem extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;
}

@Connection('sqlite')
@Model('nnb_b')
class NnbB extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;

  @Json()
  public Data: unknown;

  @BelongsTo(NnbC, 'c_id')
  public C: SingleRelation<NnbC>;

  @HasMany(NnbItem, { foreignKey: 'b_id' })
  public Items: Relation<NnbItem, NnbB>;
}

@Connection('sqlite')
@Model('nnb_a')
class NnbA extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;

  @BelongsTo(NnbB, 'b_id')
  public B: SingleRelation<NnbB>;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

async function seed() {
  const schema = driver().schema();
  await schema.createTable('nnb_d', (t) => {
    t.int('Id').primaryKey();
    t.string('Val');
  });
  await schema.createTable('nnb_c', (t) => {
    t.int('Id').primaryKey();
    t.string('Val');
    t.int('d_id');
  });
  await schema.createTable('nnb_b', (t) => {
    t.int('Id').primaryKey();
    t.string('Val');
    t.text('Data');
    t.int('c_id');
  });
  await schema.createTable('nnb_item', (t) => {
    t.int('Id').primaryKey();
    t.string('Val');
    t.int('b_id');
  });
  await schema.createTable('nnb_a', (t) => {
    t.int('Id').primaryKey();
    t.string('Val');
    t.int('b_id');
  });

  const insert = (table: string, values: object) => driver().insert().into(table).values(values);

  await insert('nnb_d', { Id: 1, Val: 'd1' });

  await insert('nnb_c', { Id: 1, Val: 'c1', d_id: 1 });
  await insert('nnb_c', { Id: 2, Val: 'c2', d_id: null });

  await insert('nnb_b', { Id: 1, Val: 'b1', Data: null, c_id: null });
  await insert('nnb_b', { Id: 2, Val: 'b2', Data: null, c_id: 1 });
  await insert('nnb_b', { Id: 3, Val: 'b3', Data: null, c_id: 2 });
  await insert('nnb_b', { Id: 4, Val: null, Data: '{"x":1}', c_id: null });

  await insert('nnb_item', { Id: 1, Val: 'i1', b_id: 1 });
  await insert('nnb_item', { Id: 2, Val: 'i2', b_id: 1 });

  // a1: no B; a2: B without C; a3: B -> C -> D; a4: B -> C without D; a5: B with JSON data only
  await insert('nnb_a', { Id: 1, Val: 'a1', b_id: null });
  await insert('nnb_a', { Id: 2, Val: 'a2', b_id: 1 });
  await insert('nnb_a', { Id: 3, Val: 'a3', b_id: 2 });
  await insert('nnb_a', { Id: 4, Val: 'a4', b_id: 3 });
  await insert('nnb_a', { Id: 5, Val: 'a5', b_id: 4 });

  await db().reloadTableInfo();
}

describe('NULL belongsTo under a nested populate', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await seed();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('a NULL belongsTo stays empty under a nested populate', async () => {
    const rows = await NnbA.select().populate('B.C').orderBy('Id');

    expect(rows[0].B.Value).to.be.undefined;
    expect(rows[0].B.Populated).to.equal(true);
    expect(rows[1].B.Value?.Id).to.equal(1);
    expect(rows[1].B.Value?.C.Value).to.be.undefined;
    expect(rows[1].B.Value?.C.Populated).to.equal(true);
    expect(rows[2].B.Value?.C.Value?.Id).to.equal(1);
  });

  it('matches the one-level result for the same row', async () => {
    const [oneLevel] = await NnbA.select().where({ Id: 1 }).populate('B');
    const [twoLevels] = await NnbA.select().where({ Id: 1 }).populate('B.C');

    expect(oneLevel.B.Value).to.be.undefined;
    expect(twoLevels.B.Value).to.be.undefined;
    expect(twoLevels.B.Populated).to.equal(oneLevel.B.Populated);
  });

  it('a NULL belongsTo stays empty under a nested hasMany populate', async () => {
    const rows = await NnbA.select().populate('B.Items').orderBy('Id');

    expect(rows[0].B.Value).to.be.undefined;
    expect(rows[0].B.Populated).to.equal(true);
    expect(rows[1].B.Value?.Items.length).to.equal(2);
  });

  it('a present belongsTo whose only data besides its key is a JSON column is present', async () => {
    const [row] = await NnbA.select().where({ Id: 5 }).populate('B.C');
    const b = row.B.Value;

    expect(b).to.be.instanceOf(NnbB);
    expect(b?.Id).to.equal(4);
    expect(b?.Data).to.deep.equal({ x: 1 });
    expect(b?.C.Value).to.be.undefined;
  });

  describe('three levels A -> B -> C -> D', () => {
    let rows: NnbA[];

    beforeEach(async () => {
      rows = await NnbA.select().populate('B.C.D').orderBy('Id');
    });

    it('NULL at the first level: B is empty', () => {
      expect(rows[0].B.Value).to.be.undefined;
      expect(rows[0].B.Populated).to.equal(true);
    });

    it('NULL at the second level: C is empty', () => {
      const b = rows[1].B.Value;
      expect(b?.Id).to.equal(1);
      expect(b?.C.Value).to.be.undefined;
      expect(b?.C.Populated).to.equal(true);
    });

    it('NULL at the third level: D is empty', () => {
      const c = rows[3].B.Value?.C.Value;
      expect(c?.Id).to.equal(2);
      expect(c?.D.Value).to.be.undefined;
      expect(c?.D.Populated).to.equal(true);
    });

    it('no NULL: the whole chain is loaded', () => {
      const d = rows[2].B.Value?.C.Value?.D.Value;
      expect(d?.Id).to.equal(1);
      expect(d?.Val).to.equal('d1');
    });
  });
});
