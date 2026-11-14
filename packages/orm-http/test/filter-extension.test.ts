import { expect } from 'chai';
import 'mocha';
import { SelectQueryExtension } from '@spinajs/orm';
import { FilterQueryExtension, filterQuery } from '../src/index.js';

describe('FilterQueryExtension', () => {
  it('adds filter() to select builders through filterQuery', () => {
    const extension = new FilterQueryExtension();
    expect(extension).to.be.instanceOf(SelectQueryExtension);
    expect(extension.name).to.equal('orm-http');
    expect(extension.methods.filter).to.equal(filterQuery);
  });
});
