/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable prettier/prettier */
import { expect } from 'chai';
import 'mocha';
// Registers the concrete logger. Without it every `@Logger` field resolves the abstract
// `Log` from log-common and the first `Log.trace()` in Orm.resolve() throws.
import '@spinajs/log';
import { SelectQueryBuilder, Orm } from '@spinajs/orm';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { RelationModel } from './Models/RelationModel.js';
import { RelationModel3 } from './Models/RelationModel3.js';
import { User } from './Models/User.js';

function sqb() {
  const connection = db()!.Connections.get('sqlite')!;
  return connection.Container.resolve(SelectQueryBuilder, [connection]);
}

function db() {
  return DI.get(Orm);
}

/** Compiled SQL of a model-bound builder ( whose `toDB()` is typed as one output or many ). */
function sql(builder: { toDB(): any }): string {
  return builder.toDB().expression as string;
}

/**
 * `clone()` must hand every copied statement the builder it now belongs to, and every copied
 * statement must BIND to that builder instead of keeping the one it was created with.
 *
 * The reason it matters is timing: a query's table alias is normally assigned AFTER the query
 * has been cloned. `populate()` calls `setAlias()`, and the common pagination shape is
 *
 *   const q = Model.select().filter(...);
 *   const count = q.clone();       // <- cloned while neither query has an alias
 *   await q.populate('rel');       // <- assigns `$Model$` to q only
 *   await count.selectCount();
 *
 * A clone whose statements still pointed at `q` compiled `$Model$`-qualified columns into a
 * query whose own FROM has no alias, and the database rejected the whole statement with
 * "Unknown column '$Model$.x' in 'where clause'".
 */
describe('Query builder clone() statement rebinding', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('where statements bind to the clone, not to the query they were cloned from', () => {
    const query = sqb().select('*').from('users').where('name', 'like', '%a%');
    const cloned = query.clone();

    // happens after the clone was taken - this is what `populate()` does
    query.setAlias('$users$');

    expect(sql(query)).to.equal('SELECT `$users$`.* FROM `users` as `$users$` WHERE `$users$`.`name` LIKE ?');
    expect(sql(cloned)).to.equal('SELECT * FROM `users` WHERE `name` LIKE ?');
  });

  it('an alias assigned before the clone is carried by the clone', () => {
    const query = sqb().select('*').from('users').where('name', 'like', '%a%').setAlias('$users$');
    const cloned = query.clone();

    expect(sql(cloned)).to.equal('SELECT `$users$`.* FROM `users` as `$users$` WHERE `$users$`.`name` LIKE ?');
  });

  it('an alias assigned on the clone does not leak back into the original', () => {
    const query = sqb().select('*').from('users').where('name', 'like', '%a%');
    const cloned = query.clone().setAlias('$copy$');

    expect(sql(query)).to.equal('SELECT * FROM `users` WHERE `name` LIKE ?');
    expect(sql(cloned)).to.equal('SELECT `$copy$`.* FROM `users` as `$copy$` WHERE `$copy$`.`name` LIKE ?');
  });

  it('populate() on the original leaves the clone unjoined and unaliased', () => {
    const query = RelationModel.select().where('Id', 1);
    const cloned = query.clone();

    query.populate('Group');

    expect(sql(query)).to.equal('SELECT `$RelationModel$`.* FROM `RelationTable` as `$RelationModel$` LEFT JOIN `RelationTable3` as `$Group$` ON `$RelationModel$`.group_id = `$Group$`.Id WHERE `$RelationModel$`.`Id` = ?');
    expect(sql(cloned)).to.equal('SELECT * FROM `RelationTable` WHERE `Id` = ?');
  });

  it('nested where callbacks rebind too', () => {
    const query = sqb()
      .select('*')
      .from('users')
      .where(function () {
        this.where('name', 'like', '%a%').orWhere('email', 'like', '%b%');
      });
    const cloned = query.clone();

    query.setAlias('$users$');

    expect(sql(query)).to.equal('SELECT `$users$`.* FROM `users` as `$users$` WHERE ( `$users$`.`name` LIKE ? OR `$users$`.`email` LIKE ? )');
    expect(sql(cloned)).to.equal('SELECT * FROM `users` WHERE ( `name` LIKE ? OR `email` LIKE ? )');
  });

  it('whereIn statements rebind', () => {
    const query = sqb().select('*').from('users').whereIn('id', [1, 2]);
    const cloned = query.clone();

    query.setAlias('$users$');

    expect(sql(cloned)).to.equal('SELECT * FROM `users` WHERE `id` IN (?,?)');
  });

  /**
   * A correlated EXISTS is the shape every rbac `readOwn` rule in the wild is written in
   * (`this.whereExist('Owners', ...)`), so losing it on a clone silently widens a permission
   * check rather than merely producing wrong SQL.
   *
   * The correlation predicate is emitted from a LAZY statement, because the outer alias may be
   * assigned after the sub-query is built. That lazy callback used to append its predicate to
   * the sub-builder captured when the sub-query was created - never to the CLONE's own
   * sub-builder - so the clone compiled `EXISTS ( SELECT ... )` with no correlation at all:
   * true for every row of the outer query, and therefore a count that ignores the constraint.
   */
  it('a correlated EXISTS survives cloning (many to many relation)', () => {
    const query = RelationModel3.select();
    query.whereExist('Models', function () {
      this.where('Id', '=', 5);
    });

    const cloned = query.clone();

    expect(sql(query)).to.contain('WHERE owner_id = `RelationTable3`.`Id`');
    expect(sql(cloned)).to.equal(sql(query));
  });

  it('a correlated EXISTS survives cloning (has many relation)', () => {
    const query = User.select();
    query.whereExist('Metadata', function () {
      this.where('Key', '=', 'x');
    });

    const cloned = query.clone();

    expect(sql(query)).to.contain('user_id = `users`.`Id`');
    expect(sql(cloned)).to.equal(sql(query));
  });

  /**
   * The clone must correlate against ITSELF. Aliasing the original afterwards has to move the
   * original's correlation only - if the clone followed it, the clone would name an alias its
   * own FROM never declares and the database would reject the query outright.
   */
  it('a cloned EXISTS correlates to the clone, not to the query it was cloned from', () => {
    const query = User.select();
    query.whereExist('Metadata', function () {
      this.where('Key', '=', 'x');
    });

    const cloned = query.clone();
    query.setAlias('$users$');

    expect(sql(query)).to.contain('user_id = `$users$`.`Id`');
    expect(sql(cloned)).to.contain('user_id = `users`.`Id`');
    expect(sql(cloned)).to.not.contain('$users$');
  });

  it('the clone keeps working when the original is compiled first, and vice versa', () => {
    const first = User.select();
    first.whereExist('Metadata', function () {
      this.where('Key', '=', 'x');
    });
    const firstClone = first.clone();

    const second = User.select();
    second.whereExist('Metadata', function () {
      this.where('Key', '=', 'x');
    });
    const secondClone = second.clone();

    // compile order must not matter: the lazy correlation is rebuilt per compile
    const a = sql(first);
    const b = sql(firstClone);
    const c = sql(secondClone);
    const d = sql(second);

    expect(a).to.equal(b);
    expect(c).to.equal(d);
    expect(a).to.equal(c);
  });

  it('compiling the same query twice does not duplicate the lazy correlation', () => {
    const query = RelationModel3.select();
    query.whereExist('Models', function () {
      this.where('Id', '=', 5);
    });

    const once = sql(query);
    const twice = sql(query);

    expect(twice).to.equal(once);
    expect(once.match(/owner_id = /g)).to.have.length(1);
  });
});
