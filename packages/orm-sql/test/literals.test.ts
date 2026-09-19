import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { DateTime } from 'luxon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { LiteralQuoter, Orm } from '@spinajs/orm';

import { inlineBindings, SqlLiteralQuoter } from '../src/literals.js';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

describe('literal quoting', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const quoter = () => DI.get(Orm)!.Connections.get('sqlite')!.Container.resolve<LiteralQuoter>(LiteralQuoter);

  it('resolves from the driver container', () => {
    expect(quoter()).to.be.instanceOf(SqlLiteralQuoter);
  });

  it('writes null and undefined as NULL', () => {
    expect(quoter().quote(null)).to.eq('NULL');
    expect(quoter().quote(undefined)).to.eq('NULL');
  });

  it('writes numbers and bigints as they are', () => {
    expect(quoter().quote(42)).to.eq('42');
    expect(quoter().quote(-1.5)).to.eq('-1.5');
    expect(quoter().quote(10n)).to.eq('10');
  });

  it('refuses a non finite number', () => {
    expect(() => quoter().quote(NaN)).to.throw(InvalidArgument);
    expect(() => quoter().quote(Infinity)).to.throw(InvalidArgument);
  });

  it('writes booleans as 1 and 0', () => {
    expect(quoter().quote(true)).to.eq('1');
    expect(quoter().quote(false)).to.eq('0');
  });

  it('quotes a string and doubles embedded quotes', () => {
    expect(quoter().quote('admin')).to.eq(`'admin'`);
    expect(quoter().quote(`it's`)).to.eq(`'it''s'`);
    expect(quoter().quote(`'; DROP TABLE x; --`)).to.eq(`'''; DROP TABLE x; --'`);
  });

  it('writes dates through the datetime converter of the driver', () => {
    expect(quoter().quote(DateTime.fromSQL('2025-11-21 05:27:43'))).to.eq(`'2025-11-21 05:27:43.000'`);
    expect(quoter().quote(new Date(2025, 10, 21, 5, 27, 43))).to.eq(`'2025-11-21 05:27:43.000'`);
  });

  it('refuses a value it has no literal for', () => {
    expect(() => quoter().quote({})).to.throw(InvalidArgument);
    expect(() => quoter().quote([1])).to.throw(InvalidArgument);
    expect(() => quoter().quote(Buffer.from('x'))).to.throw(InvalidArgument);
  });
});

describe('inlineBindings', () => {
  const marker = { quote: (value: unknown) => `<${String(value)}>` } as LiteralQuoter;

  it('returns the expression untouched when there are no bindings', () => {
    expect(inlineBindings('SELECT ? FROM t', [], marker)).to.eq('SELECT ? FROM t');
  });

  it('replaces placeholders in order', () => {
    expect(inlineBindings('a = ? AND b = ?', [1, 'x'], marker)).to.eq('a = <1> AND b = <x>');
  });

  it('skips placeholders inside quoted regions', () => {
    expect(inlineBindings(`SELECT '?', "?", \`?\`, ?`, [7], marker)).to.eq(`SELECT '?', "?", \`?\`, <7>`);
  });

  it('reads a doubled quote as an escaped quote', () => {
    expect(inlineBindings(`a = 'it''s ?' AND b = ?`, [7], marker)).to.eq(`a = 'it''s ?' AND b = <7>`);
  });

  it('skips placeholders inside comments', () => {
    expect(inlineBindings('SELECT ? -- why?\n, ? /* really? */', [1, 2], marker)).to.eq('SELECT <1> -- why?\n, <2> /* really? */');
  });

  it('throws when placeholders outnumber bindings', () => {
    expect(() => inlineBindings('a = ? AND b = ?', [1], marker)).to.throw(InvalidOperation);
  });

  it('throws when bindings outnumber placeholders', () => {
    expect(() => inlineBindings('a = ?', [1, 2], marker)).to.throw(InvalidOperation);
  });
});
