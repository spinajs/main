import { expect } from 'chai';
import 'mocha';
import { SelectQueryExtension } from '@spinajs/orm';
import { IntlQueryExtension, translateQuery } from '../src/index.js';

describe('IntlQueryExtension', () => {
  it('adds translate() to select builders through translateQuery', () => {
    const extension = new IntlQueryExtension();
    expect(extension).to.be.instanceOf(SelectQueryExtension);
    expect(extension.name).to.equal('intl-orm');
    expect(extension.methods.translate).to.equal(translateQuery);
  });
});
