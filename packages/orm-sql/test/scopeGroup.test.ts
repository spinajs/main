import { expect } from 'chai';
import 'mocha';
// Registers the concrete logger, as every suite in this package does.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { DeleteQueryBuilder, Orm, RawQuery, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

function connection(): FakeSqliteDriver {
  return DI.get(Orm)!.Connections.get('sqlite') as FakeSqliteDriver;
}

function sqb() {
  return connection().Container.resolve(SelectQueryBuilder, [connection()]);
}

/** Marks the last statement as a default scope, as createQuery does for `@SoftDelete` / `@Archived`. */
function scoped<B extends IWhereBuilder<unknown>>(builder: B): B {
  const statement = builder.Statements.at(-1);
  if (statement) {
    statement.Scope = true;
  }
  return builder;
}

const expression = (out: unknown): string => (Array.isArray(out) ? (out[0] as { expression: string }).expression : (out as { expression: string }).expression);

describe('default scopes are ANDed with the rest of the where clause as one group', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('an OR between two conditions is grouped behind the scopes', () => {
    const query = scoped(scoped(sqb().from('t').whereNull('deleted_at')).whereNull('archived_at')).where('a', 1).orWhere('b', 2);
    expect(query.toDB().expression).to.equal('SELECT * FROM `t` WHERE `deleted_at` IS NULL AND `archived_at` IS NULL AND ( `a` = ? OR `b` = ? )');
  });

  it('an OR on the first condition only cannot widen anything: no group', () => {
    const query = scoped(sqb().from('t').whereNull('deleted_at')).orWhere('id', 4);
    expect(query.toDB().expression).to.equal('SELECT * FROM `t` WHERE `deleted_at` IS NULL AND `id` = ?');
  });

  it('a raw condition with a bare OR is grouped; an OR inside quotes or parentheses is not', () => {
    expect(scoped(sqb().from('t').whereNull('deleted_at')).where(RawQuery.create('x = 1 OR 1 = 1')).toDB().expression).to.equal('SELECT * FROM `t` WHERE `deleted_at` IS NULL AND ( x = 1 OR 1 = 1 )');
    expect(scoped(sqb().from('t').whereNull('deleted_at')).where(RawQuery.create('x = 1 || 1 = 1')).toDB().expression).to.equal('SELECT * FROM `t` WHERE `deleted_at` IS NULL AND ( x = 1 || 1 = 1 )');
    expect(scoped(sqb().from('t').whereNull('deleted_at')).where(RawQuery.create("x = 'a OR b' AND (y = 1 OR y = 2)")).toDB().expression).to.equal("SELECT * FROM `t` WHERE `deleted_at` IS NULL AND x = 'a OR b' AND (y = 1 OR y = 2)");
    expect(scoped(sqb().from('t').whereNull('deleted_at')).where(RawQuery.create('`or` = 1 AND color = 2')).toDB().expression).to.equal('SELECT * FROM `t` WHERE `deleted_at` IS NULL AND `or` = 1 AND color = 2');
  });

  it('groups raw text it cannot read: a comment or a backslash escape may hide an OR', () => {
    const grouped = (raw: string) => scoped(sqb().from('t').whereNull('deleted_at')).where(RawQuery.create(raw)).toDB().expression;
    expect(grouped('1 = 0 /* ( */ OR 1 = 1 /* ) */')).to.equal('SELECT * FROM `t` WHERE `deleted_at` IS NULL AND ( 1 = 0 /* ( */ OR 1 = 1 /* ) */ )');
    expect(grouped('1 = 0 -- (\nOR 1 = 1 -- )\n')).to.equal('SELECT * FROM `t` WHERE `deleted_at` IS NULL AND ( 1 = 0 -- (\nOR 1 = 1 -- )\n )');
    // MySQL reads the backslash as an escape: '\'' is one quote and the ORs stand outside any string
    expect(grouped("title = '\\'' OR 1 = 1 OR title = '\\''")).to.equal("SELECT * FROM `t` WHERE `deleted_at` IS NULL AND ( title = '\\'' OR 1 = 1 OR title = '\\'' )");
  });

  it('keeps an AND-only clause as it was, in its own order', () => {
    const query = sqb().from('t').where('a', 1);
    scoped(query.whereNull('deleted_at')).where(function () {
      this.where('b', 2).orWhere('c', 3);
    });
    expect(query.toDB().expression).to.equal('SELECT * FROM `t` WHERE `a` = ? AND `deleted_at` IS NULL AND ( `b` = ? OR `c` = ? )');
  });

  it('emits the scopes first and binds in the order it emits', () => {
    const query = sqb().from('t').where('a', 1);
    scoped(query.where('tenant', 5)).orWhere('c', 3);
    const out = query.toDB();
    expect(out.expression).to.equal('SELECT * FROM `t` WHERE `tenant` = ? AND ( `a` = ? OR `c` = ? )');
    expect(out.bindings).to.deep.equal([5, 1, 3]);
  });

  it('groups apart inside a nested group too, and a clone keeps the mark', () => {
    const query = sqb().from('t');
    const scope = scoped(sqb().from('t').whereNull('deleted_at')).Statements[0];
    query.where(function () {
      this.Statements.push(scope);
      this.where('a', 1).orWhere('b', 2);
    });
    query.where('tenant', 5);
    const grouped = 'SELECT * FROM `t` WHERE ( `deleted_at` IS NULL AND ( `a` = ? OR `b` = ? ) ) AND `tenant` = ?';
    expect(query.toDB().expression).to.equal(grouped);
    expect(query.clone().toDB().expression).to.equal(grouped);

    const flat = scoped(sqb().from('t').whereNull('deleted_at')).where('a', 1).orWhere('b', 2);
    expect(flat.clone().toDB().expression).to.equal('SELECT * FROM `t` WHERE `deleted_at` IS NULL AND ( `a` = ? OR `b` = ? )');
  });

  it('applies to an update and a delete that carry a scope', () => {
    const del = connection().Container.resolve(DeleteQueryBuilder, [connection()]).from('t');
    scoped(del.whereNull('deleted_at')).where('a', 1).orWhere('b', 2);
    expect(expression(del.toDB())).to.equal('DELETE FROM `t` WHERE `deleted_at` IS NULL AND ( `a` = ? OR `b` = ? )');

    const upd = connection().Container.resolve(UpdateQueryBuilder, [connection()]).in('t').update({ x: 1 });
    scoped(upd.whereNull('deleted_at')).where('a', 1).orWhere('b', 2);
    expect(expression(upd.toDB())).to.equal('UPDATE `t` SET `x` = ? WHERE `deleted_at` IS NULL AND ( `a` = ? OR `b` = ? )');
  });
});
