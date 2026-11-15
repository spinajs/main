import 'mocha';
import { expect } from 'chai';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DateTime } from 'luxon';
import type { ColumnFamily } from '@spinajs/manifest';
import { IModelDescriptor, InvalidCursor } from '../src/index.js';
import { decodeCursor, encodeCursor, keysetColumns, keysetPage } from '../src/keyset.js';

const descriptor = { Name: 'Doc', PrimaryKey: ['Id'] } as unknown as IModelDescriptor;

describe('keysetColumns', () => {
  it('appends the primary key ascending as the tie-breaker', () => {
    expect(keysetColumns([['Score', 'desc']], descriptor)).to.deep.equal([
      { column: 'Score', order: 'desc' },
      { column: 'Id', order: 'asc' },
    ]);
  });

  it('keeps a primary key the order already names, in its own direction', () => {
    expect(keysetColumns([['Id', 'desc']], descriptor)).to.deep.equal([{ column: 'Id', order: 'desc' }]);
  });

  it('refuses a model without a primary key', () => {
    const keyless = { Name: 'Keyless', PrimaryKey: [] } as unknown as IModelDescriptor;
    expect(() => keysetColumns([['Score', 'asc']], keyless)).to.throw(InvalidOperation, /primary key/);
  });
});

describe('keyset cursors', () => {
  const columns = keysetColumns(
    [
      ['At', 'asc'],
      ['Name', 'desc'],
      ['Big', 'asc'],
      ['Flag', 'asc'],
    ],
    descriptor,
  );
  const row = { At: DateTime.fromISO('2026-03-01T10:00:00.000Z', { zone: 'utc' }), Name: 'ł', Big: 12345678901234567890n, Flag: false, Id: 7 };

  it('round-trips datetimes, strings, bigints, booleans and numbers', () => {
    const values = decodeCursor(columns, encodeCursor(columns, row));

    expect((values[0] as DateTime).toISO()).to.eq('2026-03-01T10:00:00.000Z');
    expect(values.slice(1)).to.deep.equal(['ł', 12345678901234567890n, false, 7]);
  });

  it('reads a Date back as a UTC DateTime', () => {
    const values = decodeCursor(columns, encodeCursor(columns, { ...row, At: new Date('2026-03-01T10:00:00.000Z') }));

    expect(DateTime.isDateTime(values[0])).to.eq(true);
    expect((values[0] as DateTime).toISO()).to.eq('2026-03-01T10:00:00.000Z');
  });

  it('is URL safe', () => {
    expect(encodeCursor(columns, row)).to.match(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses to make a cursor from a NULL order value', () => {
    expect(() => encodeCursor(columns, { ...row, Name: null })).to.throw(InvalidOperation, /NOT NULL/);
  });

  it('refuses a cursor made for another order', () => {
    const other = keysetColumns(
      [
        ['At', 'asc'],
        ['Name', 'asc'],
        ['Big', 'asc'],
        ['Flag', 'asc'],
      ],
      descriptor,
    );

    expect(() => decodeCursor(other, encodeCursor(columns, row))).to.throw(InvalidCursor, /another order/);
  });

  it('refuses garbage, a wrong value count and a value of an unknown shape', () => {
    expect(() => decodeCursor(columns, 'AAAA')).to.throw(InvalidCursor);

    const short = Buffer.from(JSON.stringify({ h: 'x', v: [1] })).toString('base64url');
    expect(() => decodeCursor(columns, short)).to.throw(InvalidCursor);

    const payload = JSON.parse(Buffer.from(encodeCursor(columns, row), 'base64url').toString('utf8')) as { h: string; v: unknown[] };
    payload.v[1] = { evil: true };
    expect(() => decodeCursor(columns, Buffer.from(JSON.stringify(payload)).toString('base64url'))).to.throw(InvalidCursor, /shape/);
  });

  it('is an InvalidArgument, which http answers with 400', () => {
    expect(new InvalidCursor('x')).to.be.instanceOf(InvalidArgument);
  });
});

describe('keysetPage', () => {
  const columns = keysetColumns([['Score', 'asc']], descriptor);
  const rows = [1, 2, 3, 4].map((id) => ({ Id: id, Score: id }));

  it('trims the probe row and links forward only on a first page', () => {
    const page = keysetPage(columns, rows, 3, { cursor: undefined, backward: false });

    expect(page.items.map((r) => r.Id)).to.deep.equal([1, 2, 3]);
    expect(decodeCursor(columns, page.next!)).to.deep.equal([3, 3]);
    expect(page.previous).to.eq(null);
  });

  it('restores the order of a backward page and links both ways', () => {
    const page = keysetPage(columns, [...rows].reverse(), 3, { cursor: 'c', backward: true });

    expect(page.items.map((r) => r.Id)).to.deep.equal([2, 3, 4]);
    expect(decodeCursor(columns, page.next!)).to.deep.equal([4, 4]);
    expect(decodeCursor(columns, page.previous!)).to.deep.equal([2, 2]);
  });

  it('has no next on the last forward page', () => {
    const page = keysetPage(columns, rows.slice(0, 2), 3, { cursor: 'c', backward: false });

    expect(page.next).to.eq(null);
    expect(page.previous).to.be.a('string');
  });

  it('links an empty backward page forward to where it was asked from', () => {
    const page = keysetPage(columns, [], 3, { cursor: 'c', backward: true });

    expect(page.items).to.deep.equal([]);
    expect(page.next).to.eq('c');
    expect(page.previous).to.eq(null);
  });
});

describe('cursor values against the column families', () => {
  const columns = keysetColumns([['Score', 'asc']], descriptor);
  const int4: ColumnFamily[][] = [['integer'], ['integer']];

  function cursorWith(score: unknown): string {
    const payload = JSON.parse(Buffer.from(encodeCursor(columns, { Score: 1, Id: 1 }), 'base64url').toString('utf8')) as { h: string; v: unknown[] };
    payload.v[0] = score;
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  it('refuses a value an integer column cannot hold', () => {
    for (const value of ['abc', 1.5, true, { $d: '2020-01-01' }, { $b: '99999999999999999999999' }, 2 ** 40]) {
      expect(() => decodeCursor(columns, cursorWith(value), int4), JSON.stringify(value)).to.throw(InvalidCursor, /Score/);
    }
  });

  it('takes a bigint within int64 where the column holds bigint', () => {
    const wide: ColumnFamily[][] = [['integer', 'bigint'], ['integer']];

    expect(decodeCursor(columns, cursorWith({ $b: '9007199254740993' }), wide)[0]).to.eq(9007199254740993n);
    expect(decodeCursor(columns, cursorWith(2 ** 40), wide)[0]).to.eq(2 ** 40);
    expect(() => decodeCursor(columns, cursorWith({ $b: '9223372036854775808' }), wide)).to.throw(InvalidCursor);
  });

  it('takes only the kinds of each family', () => {
    const cases: Array<[ColumnFamily, unknown[], unknown[]]> = [
      ['text', ['x'], [5, true]],
      ['time', ['10:30', '10:30:15.5'], ['abc']],
      ['enum', ['open'], [{ $d: '2020-01-01T00:00:00.000Z' }]],
      ['decimal', [1.5, '-12.50'], ['abc', true]],
      ['float', [1.5], ['1.5']],
      ['boolean', [true, false], ['true', 2]],
      ['datetime', [{ $d: '2020-01-01T00:00:00.000Z' }], ['2020-01-01', 5]],
      ['uuid', ['0b6f7c2e-3c1d-4a8e-9f0a-2b1c3d4e5f60'], ['nope', 5]],
    ];

    for (const [family, accepted, refused] of cases) {
      for (const value of accepted) {
        expect(() => decodeCursor(columns, cursorWith(value), [[family], ['integer']]), `${family} ${JSON.stringify(value)}`).to.not.throw();
      }
      for (const value of refused) {
        expect(() => decodeCursor(columns, cursorWith(value), [[family], ['integer']]), `${family} ${JSON.stringify(value)}`).to.throw(InvalidCursor);
      }
    }
  });

  it('checks a type with an unchecked family by its checked ones (mssql nvarchar, pg bytea)', () => {
    expect(() => decodeCursor(columns, cursorWith(5), [['text', 'enum', 'json'], ['integer']])).to.throw(InvalidCursor);
    expect(() => decodeCursor(columns, cursorWith('nope'), [['binary', 'uuid'], ['integer']])).to.throw(InvalidCursor);
  });

  it('leaves a column of an unknown type unchecked', () => {
    expect(decodeCursor(columns, cursorWith('abc'), [undefined, undefined])[0]).to.eq('abc');
  });

  it('refuses a cursor longer than 4096 characters before decoding it', () => {
    expect(() => decodeCursor(columns, 'A'.repeat(4097))).to.throw(InvalidCursor, /long/);
  });
});
