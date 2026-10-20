import 'mocha';
import { expect } from 'chai';
import { QueryMiddleware } from '@spinajs/orm';
import { IntlQueryMiddleware } from '../src/index.js';

describe('intl-orm query middleware order', () => {
  it('runs at 1000, after authz scoping (100)', () => {
    const intl = new IntlQueryMiddleware();
    expect(intl).to.be.instanceOf(QueryMiddleware);
    expect(intl.order).to.equal(1000);
    expect(intl.order).to.be.greaterThan(100);
  });
});
