import 'mocha';
import { expect } from 'chai';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DateTime } from 'luxon';
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
});
