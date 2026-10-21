import * as chai from 'chai';
import 'mocha';

import type { TupleStore } from '../../src/index.js';
import { d1, d2, f1, ref, set, tuple, user } from './world.js';

const expect = chai.expect;

const ADMIN = user('admin');
const ids = (refs: readonly { readonly id?: string }[]): string[] => refs.map((r) => r.id!).sort();

/** The TupleStore contract every store passes; `make` gives an empty store. */
export function tupleStoreContract(name: string, make: () => Promise<TupleStore> | TupleStore): void {
  describe(`${name}: the TupleStore contract`, () => {
    let store: TupleStore;

    beforeEach(async () => {
      store = await make();
      await store.write([tuple(d1, 'viewer', user('alice')), tuple(d1, 'viewer', set('group', 'eng', 'member')), tuple(d2, 'viewer', user('alice')), tuple(d2, 'parent', { type: 'folder', id: 'f1' }), tuple(d1, 'owner', user('bob'))], [], ADMIN);
    });

    it('reads the tuples of object#relation, with both subject shapes', async () => {
      const read = await store.read(d1, 'viewer');
      expect(read).to.have.deep.members([tuple(d1, 'viewer', user('alice')), tuple(d1, 'viewer', set('group', 'eng', 'member'))]);
      expect(await store.read(d1, 'editor')).to.deep.equal([]);
      expect(await store.read(ref('doc', 'd9'), 'viewer')).to.deep.equal([]);
    });

    it('reverses a subject to the objects of a type, matching the subject exactly', async () => {
      expect(ids(await store.reverse(user('alice'), 'viewer', 'doc'))).to.deep.equal(['d1', 'd2']);
      expect(ids(await store.reverse(set('group', 'eng', 'member'), 'viewer', 'doc'))).to.deep.equal(['d1']);
      expect(ids(await store.reverse(set('group', 'eng', 'owner'), 'viewer', 'doc'))).to.deep.equal([]);
      expect(ids(await store.reverse({ type: 'folder', id: 'f1' }, 'parent', 'doc'))).to.deep.equal(['d2']);
      expect(ids(await store.reverse(user('alice'), 'viewer', 'folder'))).to.deep.equal([]);
      expect(ids(await store.reverseMany([user('alice'), user('bob'), set('group', 'eng', 'member')], 'viewer', 'doc'))).to.deep.equal(['d1', 'd2']);
      expect(await store.reverseMany([], 'viewer', 'doc')).to.deep.equal([]);
    });

    it('writes idempotently and removes before it adds', async () => {
      await store.write([tuple(d1, 'viewer', user('alice'))], [], ADMIN);
      expect(await store.read(d1, 'viewer')).to.have.length(2);
      await store.write([], [tuple(d1, 'viewer', user('alice')), tuple(d1, 'viewer', user('nobody'))], ADMIN);
      expect(await store.read(d1, 'viewer')).to.deep.equal([tuple(d1, 'viewer', set('group', 'eng', 'member'))]);
      await store.write([tuple(d1, 'viewer', user('carol'))], [tuple(d1, 'viewer', user('carol'))], ADMIN);
      expect(ids(await store.reverse(user('carol'), 'viewer', 'doc'))).to.deep.equal(['d1']);
    });

    it('returns a new version on every write', async () => {
      const a = await store.write([tuple(f1, 'viewer', user('dave'))], [], ADMIN);
      const b = await store.write([], [tuple(f1, 'viewer', user('dave'))], ADMIN);
      expect(a).to.be.a('string').and.not.equal('');
      expect(b).to.not.equal(a);
    });

    it('finds by object, namespace, relation and subject, in order, with pages', async () => {
      const all = await store.find({});
      expect(all.total).to.equal(5);
      expect(all.items.map((t) => [t.object.id, t.relation])).to.deep.equal([
        ['d1', 'owner'],
        ['d1', 'viewer'],
        ['d1', 'viewer'],
        ['d2', 'parent'],
        ['d2', 'viewer'],
      ]);
      expect((await store.find({ object: d1 })).total).to.equal(3);
      expect((await store.find({ object: { type: 'doc' } })).total).to.equal(5);
      expect((await store.find({ object: { type: 'folder' } })).total).to.equal(0);
      expect((await store.find({ relation: 'viewer' })).total).to.equal(3);
      expect((await store.find({ subject: user('alice') })).items).to.have.deep.members([tuple(d1, 'viewer', user('alice')), tuple(d2, 'viewer', user('alice'))]);
      expect((await store.find({ subject: set('group', 'eng', 'member') })).items).to.deep.equal([tuple(d1, 'viewer', set('group', 'eng', 'member'))]);
      const page = await store.find({}, { limit: 2, offset: 3 });
      expect(page.total).to.equal(5);
      expect(page.items.map((t) => [t.object.id, t.relation])).to.deep.equal([
        ['d2', 'parent'],
        ['d2', 'viewer'],
      ]);
    });

    it('refuses a malformed tuple', async () => {
      let error: unknown;
      try {
        await store.write([{ object: { type: 'doc' }, relation: 'viewer', subject: user('alice') }], [], ADMIN);
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('object must name one object');
    });
  });
}
