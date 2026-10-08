import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { Hidden, ModelBase } from '@spinajs/orm';

import { filterFields } from '../src/fields.js';
import { TestDb } from './support/db.js';
import { asSystem } from './support/system.js';

const expect = chai.expect;

const decision = (read: readonly string[], write: readonly string[] = read, allowed = true): Decision => ({ allowed, fields: { read, write } } as unknown as Decision);

describe('authz-orm filterFields', () => {
  const doc = () => ({ id: 1, name: 'a', owner: { id: 2, email: 'x', profile: { bio: 'b', secret: 's' } }, tags: ['t'] });

  it('nested globs: negations deeper than a positive, the most specific glob wins', () => {
    const { data, removed } = filterFields(decision(['id', 'owner', '!owner.email', '!owner.profile.secret']), doc(), 'read');
    expect(data).to.deep.equal({ id: 1, owner: { id: 2, profile: { bio: 'b' } } });
    expect(removed).to.deep.equal(['name', 'owner.email', 'owner.profile.secret', 'tags']);

    const star = filterFields(decision(['owner.*', 'owner.profile.bio', '!owner.profile.*']), doc(), 'read');
    expect(star.data).to.deep.equal({ owner: { id: 2, email: 'x', profile: { bio: 'b' } } });
    expect(star.removed).to.deep.equal(['id', 'name', 'owner.profile.secret', 'tags']);
  });

  it("'*' keeps everything, '*' with negations drops those, an empty list drops everything", () => {
    expect(filterFields(decision(['*']), doc(), 'read')).to.deep.equal({ data: doc(), removed: [] });
    expect(filterFields(decision(['*', '!name', '!*.email']), doc(), 'read')).to.deep.equal({ data: { id: 1, owner: { id: 2, profile: { bio: 'b', secret: 's' } }, tags: ['t'] }, removed: ['name', 'owner.email'] });
    expect(filterFields(decision([]), doc(), 'read')).to.deep.equal({ data: {}, removed: ['id', 'name', 'owner', 'tags'] });
    expect(filterFields(decision(['id']), {}, 'read')).to.deep.equal({ data: {}, removed: [] });
    expect(filterFields(decision(['id']), [], 'read')).to.deep.equal({ data: [], removed: [] });
  });

  it('an array is a list of records: each is filtered, paths do not name the index, removed is the union', () => {
    const rows = [
      { id: 1, secret: 'a' },
      { id: 2, secret: 'b', extra: { x: 1 } },
    ];
    expect(filterFields(decision(['id']), rows, 'read')).to.deep.equal({ data: [{ id: 1 }, { id: 2 }], removed: ['extra', 'secret'] });
    expect(filterFields(decision(['items.a']), { items: [{ a: 1, b: 2 }, { a: 3 }] }, 'read')).to.deep.equal({ data: { items: [{ a: 1 }, { a: 3 }] }, removed: ['items.b'] });
    // Scalar elements a path denies are dropped from their array; the array's path names them.
    expect(filterFields(decision(['id']), { id: 1, tags: ['x', 'y'] }, 'read')).to.deep.equal({ data: { id: 1 }, removed: ['tags'] });
    expect(filterFields(decision(['list.a']), { list: [{ a: 1, b: 2 }, 's', null] }, 'read')).to.deep.equal({ data: { list: [{ a: 1 }] }, removed: ['list', 'list.b'] });
    expect(filterFields(decision(['list']), { list: [{ a: 1 }, 's', null] }, 'read')).to.deep.equal({ data: { list: [{ a: 1 }, 's', null] }, removed: [] });
  });

  it('removed is in one order whatever the order of the keys', () => {
    const a = filterFields(decision(['k']), { z: 1, k: 1, a: { y: 1, b: 1 }, m: 1 }, 'read').removed;
    const b = filterFields(decision(['k']), { m: 1, a: { b: 1, y: 1 }, k: 1, z: 1 }, 'read').removed;
    expect(a).to.deep.equal(['a', 'm', 'z']);
    expect(b).to.deep.equal(a);
  });

  it('values are JSON-shaped, keys JSON leaves out are not removed, and a denied getter is never called', () => {
    expect(filterFields(decision(['at']), { at: new Date(0), fn: () => 1, u: undefined }, 'read')).to.deep.equal({ data: { at: '1970-01-01T00:00:00.000Z' }, removed: [] });
    const guarded = Object.defineProperty({ id: 1 }, 'secret', {
      enumerable: true,
      get() {
        throw new Error('read');
      },
    });
    expect(filterFields(decision(['id']), guarded, 'read')).to.deep.equal({ data: { id: 1 }, removed: ['secret'] });
    const parsed = JSON.parse('{"id": 1, "__proto__": {"admin": true}}');
    const out = filterFields(decision(['*']), parsed, 'write');
    expect(out.removed).to.deep.equal(['__proto__']);
    expect(Object.prototype.hasOwnProperty.call(out.data, '__proto__')).to.equal(false);
    expect((out.data as { admin?: unknown }).admin).to.equal(undefined);
  });

  it('mode picks fields.read or fields.write; another mode is refused', () => {
    const d = decision(['id'], ['name']);
    expect(filterFields(d, { id: 1, name: 'a' }, 'read')).to.deep.equal({ data: { id: 1 }, removed: ['name'] });
    expect(filterFields(d, { id: 1, name: 'a' }, 'write')).to.deep.equal({ data: { name: 'a' }, removed: ['id'] });
    expect(() => filterFields(d, {}, 'delete' as never)).to.throw(AuthzConfigError, /mode/);
  });

  it('a denied decision keeps nothing, whatever its fields say', () => {
    const denied = decision(['*'], ['*'], false);
    expect(filterFields(denied, doc(), 'read')).to.deep.equal({ data: {}, removed: ['id', 'name', 'owner', 'tags'] });
    expect(filterFields(denied, [{ id: 1 }, { b: 2 }, 'x'], 'read')).to.deep.equal({ data: [], removed: ['b', 'id'] });
    expect(filterFields(denied, 'x', 'write')).to.deep.equal({ data: undefined, removed: [] });
    expect(filterFields(denied, null, 'write')).to.deep.equal({ data: null, removed: [] });
  });

  describe('an ORM model', function () {
    this.timeout(60000);
    let db: TestDb;
    let Doc: typeof ModelBase;

    before(async () => {
      db = await TestDb.open();
      Doc = await db.define({
        name: 'FieldDoc',
        columns: { title: 'TEXT', secret: 'TEXT', internal: 'TEXT' },
        rows: [
          { id: 'f1', title: 'one', secret: 's1', internal: 'i1' },
          { id: 'f2', title: 'two', secret: 's2', internal: 'i2' },
        ],
        decorate: (_cls, proto) => Hidden()(proto, 'internal'),
      });
    });

    after(async () => {
      await db?.close();
    });

    it('is filtered as the record its toJSON() gives: a @Hidden column is not there to remove', async () => {
      const rows = (await asSystem(() => (Doc as any).query().orderBy('id'))) as ModelBase[];
      expect(rows[0]).to.be.instanceOf(Doc);
      expect(filterFields(decision(['id', 'title']), rows[0], 'read')).to.deep.equal({ data: { id: 'f1', title: 'one' }, removed: ['secret'] });
      expect(filterFields(decision(['*', '!title']), rows, 'read')).to.deep.equal({
        data: [
          { id: 'f1', secret: 's1' },
          { id: 'f2', secret: 's2' },
        ],
        removed: ['title'],
      });
      expect(filterFields(decision(['*'], ['*'], false), rows[1], 'read')).to.deep.equal({ data: {}, removed: ['id', 'secret', 'title'] });
    });
  });
});
