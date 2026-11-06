import * as chai from 'chai';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';

import { attachRowFields, redact, rowFieldsOf } from '../../src/fields/redact.js';
import type { RedactSchema } from '../../src/fields/redact.js';
import { authzStorage, runWithPrincipal } from '../../src/host/storage.js';
import { SYSTEM } from '../../src/index.js';

const expect = chai.expect;

const NOTE = { id: 'n1', title: 't', body: 'b', InternalNote: 'x', author: { id: 'u1', email: 'e' }, lines: [{ sku: 'a', cost: 1 }] };

describe('redact()', () => {
  it('filters a record by the read globs, nested objects and arrays by dotted paths', () => {
    expect(redact(NOTE, { read: ['id', 'title', 'author.id', 'lines.sku'] })).to.deep.equal({ id: 'n1', title: 't', author: { id: 'u1' }, lines: [{ sku: 'a' }] });
  });

  it('filters every element of a list as a record', () => {
    expect(redact([NOTE, { ...NOTE, id: 'n2' }], { read: ['id'] })).to.deep.equal([{ id: 'n1' }, { id: 'n2' }]);
  });

  it('always subtracts neverRead, even from a read set that names the field', () => {
    expect(redact({ id: 'n1', Password: 'h', author: { id: 'u1', Password: 'h' } }, { read: ['id', 'Password', 'author.*'], neverRead: ['Password', '*.Password'] })).to.deep.equal({ id: 'n1', author: { id: 'u1' } });
  });

  it("uses a row's attached field set instead of the default one", () => {
    const wide = attachRowFields({ ...NOTE }, ['id', 'title', 'InternalNote']);
    const narrow = attachRowFields({ ...NOTE, id: 'n2' }, ['id']);
    const plain = { ...NOTE, id: 'n3' };
    expect(redact([wide, narrow, plain], { read: ['id', 'body'], neverRead: ['title'] })).to.deep.equal([{ id: 'n1', InternalNote: 'x' }, { id: 'n2' }, { id: 'n3', body: 'b' }]);
  });

  it('reads the attached set back and never serialises it', () => {
    const row = attachRowFields({ id: 'n1' }, ['id']);
    expect(rowFieldsOf(row)).to.deep.equal(['id']);
    expect(rowFieldsOf({ id: 'n1' })).to.equal(undefined);
    expect(JSON.stringify(row)).to.equal('{"id":"n1"}');
  });

  it('applies toJSON first, as the response serialiser does', () => {
    const model = attachRowFields({ toJSON: () => ({ id: 'n1', secret: 's' }) }, ['id']);
    expect(redact(model, { read: ['*'] })).to.deep.equal({ id: 'n1' });
  });

  it('passes primitives, null and binary values unchanged', () => {
    const bytes = new Uint8Array([1, 2]);
    expect(redact('text', { read: [] })).to.equal('text');
    expect(redact(null, { read: [] })).to.equal(null);
    expect(redact(bytes, { read: [] })).to.equal(bytes);
  });

  describe('with a schema', () => {
    const PAGE: RedactSchema = { properties: { total: {}, data: { items: { properties: { id: { 'x-spina-fields': 'note:read' }, InternalNote: { 'x-spina-fields': 'note:read' } } } } } };

    it('filters only the records the schema marks and keeps the envelope', () => {
      const rows = [attachRowFields({ ...NOTE }, ['id', 'InternalNote']), { ...NOTE, id: 'n2' }];
      expect(redact({ total: 2, data: rows }, { read: ['id'] }, PAGE)).to.deep.equal({ total: 2, data: [{ id: 'n1', InternalNote: 'x' }, { id: 'n2' }] });
    });

    it('filters a key the schema does not describe as a field of the envelope record (fails closed)', () => {
      expect(redact({ total: 1, data: [], extra: { id: 'n1', secret: 's' }, note: 'x' }, { read: ['note', 'extra.id'] }, PAGE)).to.deep.equal({ total: 1, data: [], extra: { id: 'n1' }, note: 'x' });
      expect(redact({ total: 1, data: [], extra: { id: 'n1' } }, { read: ['id'] }, PAGE)).to.deep.equal({ total: 1, data: [] });
    });

    it('treats a marked root as the record', () => {
      expect(redact(NOTE, { read: ['id'] }, { 'x-spina-fields': 'note:read' })).to.deep.equal({ id: 'n1' });
    });

    it('falls back to the root as the record when nothing is marked', () => {
      expect(redact({ total: 1, secret: 's' }, { read: ['total'] }, { properties: { total: {}, secret: {} } })).to.deep.equal({ total: 1 });
    });
  });
});

describe('AuthzRowFields in the authz storage', () => {
  let preexisting = false;
  before(() => {
    preexisting = DI.has(AsyncLocalStorage);
  });
  after(() => {
    if (!preexisting) DI.uncache(AsyncLocalStorage);
  });

  it('is not carried into runWithPrincipal: rows read as another principal must not bring its field sets', async () => {
    const seen = await authzStorage().run({ AuthzRowFields: true }, () => runWithPrincipal(SYSTEM, async () => authzStorage().getStore()?.AuthzRowFields));
    expect(seen).to.equal(undefined);
  });
});
