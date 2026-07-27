/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import 'mocha';
import { ManyToManyRelationList, SingleRelation } from '@spinajs/orm';

/**
 * This package declares relation objects directly — `Subscriber.Events` is a
 * `ManyToManyRelationList` and `Queue` holds `SingleRelation` properties — so it is the
 * closest in-repo consumer of the classes the unit-of-work branch changed. These assertions
 * pin the shape it depends on.
 */
describe('unit-of-work compatibility', () => {
  it('ManyToManyRelationList implements the three set operations', () => {
    expect(ManyToManyRelationList.prototype.intersection).to.be.a('function');
    expect(ManyToManyRelationList.prototype.union).to.be.a('function');
    expect(ManyToManyRelationList.prototype.diff).to.be.a('function');
  });

  it('SingleRelation still exposes attach, detach, set, remove and populate', () => {
    for (const name of ['attach', 'detach', 'set', 'remove', 'populate']) {
      expect((SingleRelation.prototype as any)[name], name).to.be.a('function');
    }
  });
});
