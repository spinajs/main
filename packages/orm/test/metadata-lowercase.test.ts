import * as chai from 'chai';
import 'mocha';
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import {
  ConnectionConf,
  FakeSqliteDriver,
  FakeMysqlDriver,
  FakeSelectQueryCompiler,
  FakeDeleteQueryCompiler,
  FakeInsertQueryCompiler,
  FakeUpdateQueryCompiler,
  FakeTableQueryCompiler,
  FakeConverter,
} from './misc.js';
import {
  SelectQueryCompiler,
  DeleteQueryCompiler,
  UpdateQueryCompiler,
  InsertQueryCompiler,
  TableQueryCompiler,
  DatetimeValueConverter,
} from '../src/interfaces.js';
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator } from './../src/hydrators.js';
import { Orm } from '../src/orm.js';
import { LowercaseMeta } from './mocks/models/LowercaseMeta.js';
import { LowercaseMetaOwner } from './mocks/models/LowercaseMetaOwner.js';
import './../src/bootstrap.js';

const expect = chai.expect;

async function db() {
  return await DI.resolve(Orm);
}

describe('MetadataRelation lowercase columns', () => {
  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');
    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);
    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(FakeConverter).as(DatetimeValueConverter);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('Should mark item dirty when value changes via proxy', async () => {
    await db();

    const owner = new LowercaseMetaOwner();
    const existing = new LowercaseMeta({ key: 'foo', value: 'old', owner_id: 13276 } as any);
    (owner.Metadata as any).push(existing);

    owner.Metadata['foo'] = 'new';

    expect(existing.value).to.eq('new');
    expect((existing as any).IsDirty).to.be.true;
  });

  it('Should NOT mark item dirty when value is unchanged', async () => {
    await db();

    const owner = new LowercaseMetaOwner();
    const existing = new LowercaseMeta({ key: 'foo', value: 'same', owner_id: 13276 } as any);
    (owner.Metadata as any).push(existing);

    owner.Metadata['foo'] = 'same';

    expect((existing as any).IsDirty).to.be.false;
  });

  it('Should emit FK in toSql when BelongsTo.Value is null', async () => {
    await db();

    const meta = new LowercaseMeta({ key: 'foo', value: 'bar', owner_id: 13276 } as any);
    const sql = meta.toSql() as Record<string, unknown>;

    expect(sql.owner_id).to.eq(13276);
  });

  it('Should prefer BelongsTo.Value over raw FK in toSql', async () => {
    await db();

    const newOwner = new LowercaseMetaOwner({ id: 999 } as any);
    const meta = new LowercaseMeta({ key: 'foo', value: 'bar', owner_id: 1 } as any);
    (meta as any).Owner.Value = newOwner;

    const sql = meta.toSql() as Record<string, unknown>;

    expect(sql.owner_id).to.eq(999);
  });
});
