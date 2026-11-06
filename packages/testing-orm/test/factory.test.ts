import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import '@spinajs/log';
import { BelongsTo, Connection, HasMany, Migration, Model, ModelBase, Orm, OrmDriver, OrmMigration, Primary, Relation, SingleRelation, UnitOfWork, type IDriverOptions } from '@spinajs/orm';
import { createTestApp, type TestApp } from '@spinajs/testing';

import { createTestDatabase, defineFactory, factory, type TestDatabase } from '../src/index.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

@Migration('default')
export class TestingOrmFactories_2026_11_03_00_01_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('tf_users', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name').notNull();
      t.string('Email');
    });
    await connection.schema().createTable('tf_posts', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.int('UserId').notNull();
      t.string('Title');
      t.foreignKey('UserId').references('tf_users', 'Id');
    });
  }

  public down(): Promise<void> {
    return Promise.resolve();
  }
}

@Connection('default')
@Model('tf_users')
class TfUser extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public Email: string;

  @HasMany('TfPost', { foreignKey: 'UserId', primaryKey: 'Id' })
  public Posts: Relation<TfPost, TfUser>;
}

@Connection('default')
@Model('tf_posts')
class TfPost extends ModelBase {
  @Primary()
  public Id: number;

  public UserId: number;

  public Title: string;

  @BelongsTo(TfUser, 'UserId', 'Id')
  public Author: SingleRelation<TfUser>;
}

const users = defineFactory(TfUser, ({ seq }) => ({ Name: `user ${seq}`, Email: `user${seq}@test.dev` }));
const posts = defineFactory(TfPost, ({ seq }) => ({ Title: `post ${seq}` }));

function appConfiguration(connection: Partial<IDriverOptions>): Class<Configuration> {
  return class FactoryTestConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      this.set('logger', SILENT);
      this.set('db', { DefaultConnection: 'default', Connections: [connection] });
    }
  };
}

describe('model factories', function () {
  let db: TestDatabase;
  let app: TestApp;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = await createTestApp({ configuration: appConfiguration(db.config), resolve: [Orm] });
  });

  afterEach(async () => {
    sinon.restore();
    await app.dispose();
    await db.dispose();
  });

  it('build() fills the definition with a sequence number, applies overrides and saves nothing', async () => {
    const a = users.build();
    const b = users.build({ Name: 'named' });

    expect([a.Name, a.Email, b.Name, b.Email]).to.deep.equal(['user 1', 'user1@test.dev', 'named', 'user2@test.dev']);
    expect(a.Id).to.equal(null);
    expect(await TfUser.all()).to.have.length(0);
  });

  it('create() saves through the unit of work', async () => {
    const save = sinon.spy(UnitOfWork, 'save');

    const user = await users.create();

    expect(save.calledOnce).to.equal(true);
    expect((await TfUser.get(user.Id)).Name).to.equal('user 1');
  });

  it('createMany() creates n rows with consecutive sequence numbers', async () => {
    const many = await users.createMany(3);

    expect(many.map((u) => u.Name)).to.deep.equal(['user 1', 'user 2', 'user 3']);
    expect(await TfUser.all()).to.have.length(3);
  });

  it('for() with a factory creates the owner once and points every row at it', async () => {
    const written = await posts.for('Author', users).createMany(3);

    const owners = await TfUser.all();
    expect(owners).to.have.length(1);
    expect(written.map((p) => p.UserId)).to.deep.equal([owners[0].Id, owners[0].Id, owners[0].Id]);
  });

  it('for() with a saved model sets its key, in build() too', async () => {
    const owner = await users.create({ Name: 'owner' });

    expect(posts.for('Author', owner).build().UserId).to.equal(owner.Id);
  });

  it('for() refuses a relation that is not belongs-to', () => {
    expect(() => users.for('Posts', posts)).to.throw(InvalidArgument, /TfUser.Posts is not a belongs-to relation/);
    expect(() => posts.for('Nope', users)).to.throw(InvalidArgument, /TfPost.Nope is not a belongs-to relation/);
  });

  it('factory() returns the definition registered for a model', () => {
    class Unregistered extends ModelBase {}

    expect(factory(TfUser)).to.equal(users);
    expect(() => factory(Unregistered)).to.throw(InvalidArgument, /no factory defined for Unregistered/);
  });

  it('createTestDatabase() starts the sequences over', async () => {
    users.build();
    users.build();

    await (await createTestDatabase()).dispose();

    expect(users.build().Name).to.equal('user 1');
  });

  it('createTestDatabase() forgets the owner a for() factory created', async () => {
    const byAuthor = posts.for('Author', users);
    await byAuthor.create();

    // The memoized owner lives in a schema the next test database no longer has.
    await (await createTestDatabase()).dispose();
    await byAuthor.create();

    expect(await TfUser.all()).to.have.length(2);
  });
});
