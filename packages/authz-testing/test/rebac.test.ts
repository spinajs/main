import * as chai from 'chai';
import 'mocha';

import { TupleStore } from '../src/index.js';
import type { Tuple } from '../src/index.js';
import type { PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';

const expect = chai.expect;

const file: ResourceRef = { type: 'file', id: 'f1' };
const folder: ResourceRef = { type: 'folder', id: 'd1' };

describe('authz-testing rebac shape', () => {
  it('Tuple with a principal subject and with a userset subject', () => {
    const t1: Tuple = { object: file, relation: 'viewer', subject: { type: 'user', id: 'u1' } };
    const t2: Tuple = { object: file, relation: 'parent', subject: { object: folder, relation: 'viewer' } };
    expect([t1, t2]).to.have.length(2);
  });

  it('TupleStore fake', async () => {
    const stored: Tuple[] = [];
    class Fake extends TupleStore {
      async read(object: ResourceRef, relation: string) {
        return stored.filter((t) => t.object.id === object.id && t.relation === relation);
      }
      async reverse(_subject: PrincipalRef, _relation: string, _objectType: ResourceType) {
        return [] as readonly ResourceRef[];
      }
      async write(add: readonly Tuple[], _remove: readonly Tuple[], _actor: PrincipalRef) {
        stored.push(...add);
        return String(stored.length);
      }
    }
    const s = new Fake();
    expect(await s.write([{ object: file, relation: 'viewer', subject: { type: 'user', id: 'u1' } }], [], { type: 'user', id: 'u0' })).to.equal('1');
    expect(await s.read(file, 'viewer')).to.have.length(1);
    expect(await s.reverse({ type: 'user', id: 'u1' }, 'viewer', 'file')).to.have.length(0);
  });
});
