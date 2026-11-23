import * as chai from 'chai';
import 'mocha';
import { historyEntryOf, toHistoryValue } from '../src/encode.js';
import type { HistorySpec } from '../src/registry.js';

const expect = chai.expect;

const spec = (over: Partial<HistorySpec> = {}): HistorySpec => ({
  model: class {} as never,
  entity: 'invoice',
  pk: 'id',
  columns: '*',
  exclude: new Set(),
  masked: new Set(),
  json: new Set(),
  softDelete: undefined,
  trail: 'history',
  ...over,
});

describe('history encoding', () => {
  it('normalises driver values to JSON', () => {
    expect(toHistoryValue(new Date('2026-11-06T10:00:00.000Z'))).to.eq('2026-11-06T10:00:00.000Z');
    expect(toHistoryValue(5n)).to.eq('5');
    expect(toHistoryValue(Buffer.from('hi'))).to.deep.eq({ $bytes: 'aGk=' });
    expect(toHistoryValue({ a: 1 })).to.deep.eq({ a: 1 });
  });

  it('writes an invalid date as null, as JSON does, and reads it as unchanged', () => {
    expect(toHistoryValue(new Date(NaN))).to.eq(null);
    expect(historyEntryOf(spec(), { id: '1', before: { id: 1, at: new Date(NaN) }, after: { id: 1, at: new Date(NaN) } })).to.eq(undefined);
  });

  it('records an insert as its row and a delete as the row it removed', () => {
    expect(historyEntryOf(spec(), { id: '1', before: undefined, after: { id: 1, status: 'draft' } })).to.deep.eq({ id: '1', op: 'insert', data: { after: { id: 1, status: 'draft' } } });
    expect(historyEntryOf(spec(), { id: '1', before: { id: 1, status: 'paid' }, after: undefined })).to.deep.eq({ id: '1', op: 'delete', data: { before: { id: 1, status: 'paid' } } });
  });

  it('records an update as the changed columns before and the whole row after', () => {
    const e = historyEntryOf(spec(), { id: '1', before: { id: 1, status: 'draft', total: 5 }, after: { id: 1, status: 'paid', total: 5 } });
    expect(e).to.deep.eq({ id: '1', op: 'update', data: { before: { status: 'draft' }, after: { id: 1, status: 'paid', total: 5 }, changed: ['status'] } });
  });

  it('keeps the key and every tracked column after in column mode', () => {
    const e = historyEntryOf(spec({ columns: ['status', 'tier'] }), { id: '1', before: { id: 1, status: 'draft', tier: 'free' }, after: { id: 1, status: 'paid', tier: 'free' } });
    expect(e?.data).to.deep.eq({ before: { status: 'draft' }, after: { id: 1, status: 'paid', tier: 'free' }, changed: ['status'] });
  });

  it('reads a JSON value in another key order as unchanged', () => {
    expect(historyEntryOf(spec(), { id: '1', before: { id: 1, body: { a: 1, b: [2] } }, after: { id: 1, body: { b: [2], a: 1 } } })).to.eq(undefined);
  });

  it('reads the text of a JSON column by value and keeps the text it was handed', () => {
    const s = spec({ json: new Set(['body']) });
    expect(historyEntryOf(s, { id: '1', before: { id: 1, body: '{"a":1,"b":[2]}' }, after: { id: 1, body: '{ "b": [2], "a": 1 }' } })).to.eq(undefined);
    const e = historyEntryOf(s, { id: '1', before: { id: 1, n: 1, body: '{"a":1}' }, after: { id: 1, n: 2, body: '{ "a": 1 }' } });
    expect(e?.data).to.deep.eq({ before: { n: 1 }, after: { id: 1, n: 2, body: '{ "a": 1 }' }, changed: ['n'] });
  });

  it('reads text that does not parse, and the text of an undeclared column, as text', () => {
    const s = spec({ json: new Set(['body']) });
    expect(historyEntryOf(s, { id: '1', before: { id: 1, body: '{"a":' }, after: { id: 1, body: '{"a": ' } })?.data.changed).to.deep.eq(['body']);
    expect(historyEntryOf(s, { id: '1', before: { id: 1, body: '{"a":1}' }, after: { id: 1, body: '{"a": ' } })?.data.changed).to.deep.eq(['body']);
    expect(historyEntryOf(s, { id: '1', before: { id: 1, note: '{"a":1,"b":2}' }, after: { id: 1, note: '{"b":2,"a":1}' } })?.data.changed).to.deep.eq(['note']);
  });

  it('reads the text of a JSON column as text when it holds a number a double cannot hold', () => {
    const s = spec({ json: new Set(['body']) });
    const changed = (before: string, after: string): readonly string[] | undefined => historyEntryOf(s, { id: '1', before: { id: 1, body: before }, after: { id: 1, body: after } })?.data.changed;
    expect(changed('{"n":12345678901234567891}', '{"n":12345678901234567892}')).to.deep.eq(['body']);
    expect(changed('[0.12345678901234567]', '[0.12345678901234568]')).to.deep.eq(['body']);
    expect(changed('{"a":1e400}', '{"a":null}')).to.deep.eq(['body']);
    expect(changed('{"a":1e-400}', '{"a":0}')).to.deep.eq(['body']);
    expect(changed('{"s":"12345678901234567891","n":1}', '{"n":1,"s":"12345678901234567891"}')).to.eq(undefined);
  });

  it('counts -0 against 0 and a duplicate key as no change in a JSON column', () => {
    const s = spec({ json: new Set(['body']) });
    expect(historyEntryOf(s, { id: '1', before: { id: 1, body: '{"a":-0}' }, after: { id: 1, body: '{"a":0}' } })).to.eq(undefined);
    expect(historyEntryOf(s, { id: '1', before: { id: 1, body: '{"a":1,"a":2}' }, after: { id: 1, body: '{"a":2}' } })).to.eq(undefined);
  });

  it('writes nothing for an update that changed nothing', () => {
    const at = new Date('2026-11-06T10:00:00.000Z');
    expect(historyEntryOf(spec(), { id: '1', before: { id: 1, at }, after: { id: 1, at: new Date(at.getTime()) } })).to.eq(undefined);
  });

  it('names a masked column in changed and stores none of its values', () => {
    const e = historyEntryOf(spec({ masked: new Set(['password']) }), { id: 'u', before: { id: 'u', password: 'a' }, after: { id: 'u', password: 'b' } });
    expect(e?.data).to.deep.eq({ before: {}, after: { id: 'u' }, changed: ['password'] });
  });

  it('drops excluded columns entirely', () => {
    expect(historyEntryOf(spec({ exclude: new Set(['seen']) }), { id: '1', before: { id: 1, seen: 1 }, after: { id: 1, seen: 2 } })).to.eq(undefined);
  });

  it('keeps excluded values out of the stored rows', () => {
    const s = spec({ exclude: new Set(['seen']) });
    expect(historyEntryOf(s, { id: '1', before: { id: 1, status: 'draft', seen: 1 }, after: { id: 1, status: 'paid', seen: 2 } })?.data).to.deep.eq({ before: { status: 'draft' }, after: { id: 1, status: 'paid' }, changed: ['status'] });
    expect(historyEntryOf(s, { id: '1', before: undefined, after: { id: 1, status: 'draft', seen: 1 } })?.data).to.deep.eq({ after: { id: 1, status: 'draft' } });
  });

  it('names soft deletes and restores', () => {
    const s = spec({ softDelete: 'deleted_at' });
    expect(historyEntryOf(s, { id: '1', before: { id: 1, deleted_at: null }, after: { id: 1, deleted_at: '2026-11-06' } })?.op).to.eq('soft_delete');
    expect(historyEntryOf(s, { id: '1', before: { id: 1, deleted_at: '2026-11-06' }, after: { id: 1, deleted_at: null } })?.op).to.eq('restore');
  });
});
