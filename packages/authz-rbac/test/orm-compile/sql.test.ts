import { AuthzConfigError } from '@spinajs/authz';
import { DatetimeValueConverter, IdentifierQuoter, RawQuery } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { FALSE_SQL, TRUE_SQL, andSql, ident, inList, joinSql, notSql, orSql, outer, rbacSubQuery, renderSql, rsql, textOf, whereRbacSql } from '../../src/orm/index.js';
import type { RbacSql } from '../../src/orm/index.js';
import { NOW } from '../orm/fixture.js';
import type { BootedDb } from '../orm/fixture.js';
import { DIALECTS, bootDialect, select } from './fixture.js';

const quoterOf = (open: string, close = open) => ({ quote: (n: string) => `${open}${n}${close}` } as unknown as IdentifierQuoter);

const SECOND = 1000;
const HOUR = 3600 * SECOND;

describe('authz-rbac orm-compile: rsql fragments', () => {
  it('splices nested fragments and keeps each part kind', () => {
    const inner = rsql`${ident('x', 'a')} = ${'v'}`;
    const f = rsql`(${inner}) AND ${outer('c')} IN (${[1, 2]})`;
    expect(f.parts.filter((p) => typeof p !== 'string').map((p) => p.constructor.name)).to.deep.equal(['RbacIdentifier', 'RbacBound', 'RbacOuterColumn', 'RbacBound', 'RbacBound']);
  });

  it('refuses values it cannot bind exactly', () => {
    const bad: unknown[] = [undefined, null, true, {}, [], [1, undefined], NaN, Infinity, 2n ** 60n, -(2n ** 60n), new Date(Number.NaN), Buffer.from('x'), () => 1, Symbol('s')];
    for (const v of bad) expect(() => rsql`${ident('t', 'c')} = ${v as string}`, String(v)).to.throw(AuthzConfigError);
  });

  it('refuses text that would carry a value, a placeholder, a comment or an open bracket', () => {
    for (const text of ['?', "'", '"', '`', ';', '$1', '[x]', '#', '\\', ':x', '@x', '-- c', '/* c', '(', ')']) {
      const strings = Object.assign([`a ${text} b`], { raw: [`a ${text} b`] }) as TemplateStringsArray;
      expect(() => rsql(strings), text).to.throw(AuthzConfigError);
    }
    expect(() => rsql`a -${'x'}- b`).to.not.throw();
    expect(() => joinSql([TRUE_SQL, TRUE_SQL], ' -'.concat('- '))).to.throw(AuthzConfigError);
  });

  it('refuses empty identifier names and an empty outer column', () => {
    expect(() => ident()).to.throw(AuthzConfigError);
    expect(() => ident('t', '')).to.throw(AuthzConfigError);
    expect(() => outer('')).to.throw(AuthzConfigError);
  });

  it('andSql and orSql parenthesise every operand and the whole; empty AND is TRUE, empty OR is FALSE', () => {
    const q = quoterOf('"');
    const text = (f: RbacSql) => f.parts.map((p) => (typeof p === 'string' ? p : '?')).join('');
    expect(andSql()).to.equal(TRUE_SQL);
    expect(orSql()).to.equal(FALSE_SQL);
    expect(text(TRUE_SQL)).to.equal('1 = 1');
    expect(text(FALSE_SQL)).to.equal('1 = 0');
    expect(text(andSql(rsql`a = 1 OR b = 1`, rsql`c = 1`))).to.equal('((a = 1 OR b = 1) AND (c = 1))');
    expect(text(orSql(rsql`a = 1 AND b = 1`, rsql`c = 1`))).to.equal('((a = 1 AND b = 1) OR (c = 1))');
    expect(text(notSql(rsql`a = 1 OR b = 1`))).to.equal('NOT (a = 1 OR b = 1)');
    expect(text(joinSql([rsql`a`, rsql`b`, rsql`c`], ', '))).to.equal('a, b, c');
    expect(text(textOf(rsql`a`, q))).to.equal('CAST(a AS TEXT)');
  });

  it('inList binds one parameter per value and refuses the empty list', () => {
    const f = inList(rsql`a`, ['x', 'y']);
    expect(f.parts.filter((p) => typeof p !== 'string')).to.have.length(2);
    expect(() => inList(rsql`a`, [])).to.throw(AuthzConfigError);
  });

  it('textOf casts as L2 does: CHAR for backtick quoting, NVARCHAR(4000) for brackets, TEXT otherwise', () => {
    const text = (f: RbacSql) => f.parts.join('');
    expect(text(textOf(rsql`a`, quoterOf('`')))).to.equal('CAST(a AS CHAR)');
    expect(text(textOf(rsql`a`, quoterOf('[', ']')))).to.equal('CAST(a AS NVARCHAR(4000))');
    expect(text(textOf(rsql`a`, quoterOf('"')))).to.equal('CAST(a AS TEXT)');
  });
});

for (const dialect of DIALECTS) {
  describe(`authz-rbac orm-compile: renderSql on ${dialect[0]}`, function () {
    this.timeout(60000);

    let db: BootedDb;
    let driver: OrmDriver;

    before(async function () {
      db = await bootDialect(this, dialect);
      driver = db.driver;
      await driver.schema().createTable('expiring', (t) => {
        t.int('id').primaryKey().notNull();
        t.dateTime('expires_at');
        t.string('name', 64);
      });
      const rows: Array<[number, Date | null]> = [
        [1, new Date(NOW.getTime() - HOUR)],
        [2, NOW],
        [3, new Date(NOW.getTime() + SECOND)],
        [4, new Date(NOW.getTime() + HOUR)],
        [5, null],
        [6, new Date(NOW.getTime() + 1)],
      ];
      for (const [id, expires] of rows)
        await driver
          .insert()
          .into('expiring')
          .values({ id, expires_at: expires, name: `n${id}` });
      await driver.schema().createTable('tagged', (t) => {
        t.int('id').primaryKey().notNull();
        t.int('expiring_id').notNull();
        t.string('tag', 16).notNull();
      });
      for (const [id, expiringId, tag] of [
        [1, 1, 'a'],
        [2, 3, 'a'],
        [3, 4, 'b'],
        [4, 3, 'b'],
      ] as const)
        await driver.insert().into('tagged').values({ id, expiring_id: expiringId, tag });
    });

    after(async () => {
      await db?.close();
    });

    const q = (name: string) => (dialect[0] === 'sqlite' ? `\`${name}\`` : `"${name}"`);

    it('quotes identifiers per dialect, renders outer() with the callback and binds values in order', () => {
      const f = rsql`${ident('t', 'a')} = ${'x'} AND ${outer('c')} IN (${[1, 2]}) AND ${ident('t', 'b')} = ${3}`;
      const out = renderSql(f, { driver, outer: (c) => `OUTER.${c}` });
      expect(out.text).to.equal(`${q('t')}.${q('a')} = ? AND OUTER.c IN (?, ?) AND ${q('t')}.${q('b')} = ?`);
      expect(out.bindings).to.deep.equal(['x', 1, 2, 3]);
    });

    it('binds a safe bigint as a number', () => {
      expect(renderSql(rsql`a = ${42n}`, { driver, outer: (c) => c }).bindings).to.deep.equal([42]);
    });

    it('binds a Date as the connection datetime converter writes it', () => {
      const out = renderSql(rsql`a > ${NOW}`, { driver, outer: (c) => c });
      expect(out.bindings).to.deep.equal([driver.Container.resolve(DatetimeValueConverter).toDB(NOW, undefined as never, undefined as never)]);
    });

    it('expires_at > now round-trips against what the ORM stored: now itself is excluded', async () => {
      const live = await select(driver, rsql`SELECT ${outer('id')} AS id FROM ${ident('expiring')} r WHERE ${outer('expires_at')} > ${NOW} ORDER BY ${outer('id')}`);
      expect(live.map((r) => Number(r.id))).to.deep.equal([3, 4, 6]);
    });

    it('refuses a Date made invalid after the fragment was built', () => {
      const d = new Date(NOW.getTime());
      const f = rsql`a > ${d}`;
      d.setTime(Number.NaN);
      expect(() => renderSql(f, { driver, outer: (c) => c })).to.throw(AuthzConfigError);
    });

    it('refuses an identifier that is or is qualified by the outer row name, in any letter case: that alias would shadow the filtered row', () => {
      expect(() => renderSql(rsql`FROM ${ident('t')} ${ident('R')}`, { driver, outer: (c) => c, outerName: 'r' })).to.throw(AuthzConfigError, /"R"/);
      expect(() => renderSql(rsql`${ident('r', 'scope_id')} = ${'1'}`, { driver, outer: (c) => c, outerName: 'r' })).to.throw(AuthzConfigError, /"r"/);
      expect(() => renderSql(rsql`${ident('R', 'scope_id')} = ${'1'}`, { driver, outer: (c) => c, outerName: 'r' })).to.throw(AuthzConfigError, /"R"/);
      expect(() => renderSql(rsql`${ident('x', 'scope_id')} = ${'1'}`, { driver, outer: (c) => c, outerName: 'r' })).to.not.throw();
    });

    it('whereRbacSql adds the fragment to a query, reading the outer alias when the SQL is built', async () => {
      const query = driver.select<Array<{ id: number }>>().from('expiring').columns(['id']).orderBy('id');
      whereRbacSql(query, rsql`${outer('name')} IN (${['n1', 'n4']}) OR ${outer('id')} = ${6}`);
      query.where('id', '<>', 4);
      query.setAlias('later');
      const ids = ((await query) as unknown as Array<{ id: number | string }>).map((r) => Number(r.id));
      expect(ids).to.deep.equal([1, 6]);
      const { expression } = query.toDB() as unknown as { expression: string };
      expect(expression).to.contain(`${q('later')}.${q('name')} IN (?, ?)`);
    });

    it('whereRbacSql in a where group, and refusing an alias equal to the outer one', async () => {
      const query = driver.select<Array<{ id: number }>>().from('expiring', 'e').columns(['id']).orderBy('id');
      query.where(function () {
        whereRbacSql(this, rsql`${outer('id')} = ${2}`);
        this.orWhere('id', 3);
      });
      expect(((await query) as unknown as Array<{ id: number | string }>).map((r) => Number(r.id))).to.deep.equal([2, 3]);

      const clash = driver.select().from('expiring', 'e').columns(['id']);
      whereRbacSql(clash, rsql`${ident('e', 'id')} = ${1}`);
      expect(() => clash.toDB()).to.throw(AuthzConfigError);
    });

    const ids = async (query: unknown): Promise<number[]> => ((await query) as Array<{ id: number | string }>).map((r) => Number(r.id));

    it('whereRbacSql in a correlated sub-query: outer() names the filtered row', async () => {
      const query = driver.select<Array<{ id: number }>>().from('expiring', 'e').columns(['id']).orderBy('id');
      const sub = rbacSubQuery(query, 'tagged', 't');
      whereRbacSql(sub, rsql`${ident('t', 'expiring_id')} = ${outer('id')} AND ${ident('t', 'tag')} = ${'a'}`);
      query.whereExist(sub);
      expect(await ids(query)).to.deep.equal([1, 3]);
      const { expression } = query.toDB() as unknown as { expression: string };
      expect(expression).to.contain(`${q('t')}.${q('expiring_id')} = ${q('e')}.${q('id')}`);
      expect(await ids(query.clone()), 'a clone keeps the sub-query marked').to.deep.equal([1, 3]);
    });

    it('whereRbacSql in a sub-query nested in a correlated sub-query: outer() still names the filtered row', async () => {
      const query = driver.select<Array<{ id: number }>>().from('expiring', 'e').columns(['id']).orderBy('id');
      const sub = rbacSubQuery(query, 'tagged', 't');
      whereRbacSql(sub, rsql`${ident('t', 'expiring_id')} = ${outer('id')}`);
      const nested = rbacSubQuery(sub, 'tagged', 't2');
      nested.where(function () {
        whereRbacSql(this, rsql`${ident('t2', 'expiring_id')} = ${outer('id')} AND ${ident('t2', 'tag')} = ${'b'} AND ${ident('t2', 'id')} <> ${ident('t', 'id')}`);
      });
      sub.whereExist(nested);
      query.whereExist(sub);
      // e 3 has tags a and b: some t is not the b row t2. e 4 has only its b row.
      expect(await ids(query)).to.deep.equal([3]);
      const { expression } = query.toDB() as unknown as { expression: string };
      expect(expression).to.contain(`${q('t2')}.${q('expiring_id')} = ${q('e')}.${q('id')}`);
    });

    it('whereRbacSql refuses a sub-query alias that shadows the filtered row, in any letter case', () => {
      for (const alias of ['e', 'E']) {
        const query = driver.select().from('expiring', 'e').columns(['id']);
        const sub = rbacSubQuery(query, 'tagged', alias);
        whereRbacSql(sub, rsql`${outer('id')} > ${0}`);
        query.whereExist(sub);
        expect(() => query.toDB(), alias).to.throw(AuthzConfigError);
      }
    });

    it('a query the orm correlates with a parent (a relation query) is the filtered row, not its parent', async () => {
      // As the orm's relation EXISTS builds it: the parent shares column names (id) with the filtered table.
      const parent = driver.select<Array<{ id: number }>>().from('expiring', 'p').columns(['id']).orderBy('id');
      const filtered = driver.select().from('tagged', 'f').correlateWith(parent);
      filtered.where(new RawQuery(`${q('f')}.${q('expiring_id')} = ${q('p')}.${q('id')}`));
      const sub = rbacSubQuery(filtered, 'tagged', 'authz_a');
      whereRbacSql(sub, rsql`${ident('authz_a', 'id')} = ${outer('id')} AND ${ident('authz_a', 'tag')} = ${'a'}`);
      filtered.whereExist(sub);
      parent.whereExist(filtered);
      // f rows tagged a: 1 (e 1) and 2 (e 3). Read against p.id it would be ids 1 and 2 of expiring, which lists e 1 only.
      expect(await ids(parent)).to.deep.equal([1, 3]);
      const { expression } = parent.toDB() as unknown as { expression: string };
      expect(expression).to.contain(`${q('authz_a')}.${q('id')} = ${q('f')}.${q('id')}`);
      expect(expression).to.not.contain(`${q('authz_a')}.${q('id')} = ${q('p')}.${q('id')}`);
    });

    it('whereRbacSql on a relation query itself names that query, not its parent', async () => {
      const parent = driver.select<Array<{ id: number }>>().from('expiring', 'p').columns(['id']).orderBy('id');
      const filtered = driver.select().from('tagged', 'f').correlateWith(parent);
      filtered.where(new RawQuery(`${q('f')}.${q('expiring_id')} = ${q('p')}.${q('id')}`));
      whereRbacSql(filtered, rsql`${outer('id')} = ${4}`);
      parent.whereExist(filtered);
      expect(await ids(parent)).to.deep.equal([3]);
    });
  });
}
