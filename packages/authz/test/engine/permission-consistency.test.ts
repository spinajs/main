import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, PermissionRegistryImpl } from '../../src/index.js';

const expect = chai.expect;

describe('PermissionDef.consistency', () => {
  it('is absent unless a source declares it', () => {
    const r = new PermissionRegistryImpl();
    r.register([{ name: 'doc:read' }, { name: 'doc:delete', consistency: 'fresh' }], 'test');
    expect(r.require('doc:read').consistency).to.equal(undefined);
    expect(r.require('doc:delete').consistency).to.equal('fresh');
  });

  it('fresh from any source wins over cached', () => {
    const r = new PermissionRegistryImpl();
    r.register([{ name: 'doc:delete', consistency: 'cached' }], 'a');
    r.register([{ name: 'doc:delete', consistency: 'fresh' }], 'b');
    r.register([{ name: 'doc:delete', consistency: 'cached' }], 'c');
    expect(r.require('doc:delete').consistency).to.equal('fresh');
  });

  it('refuses any other value', () => {
    const r = new PermissionRegistryImpl();
    expect(() => r.register([{ name: 'doc:read', consistency: 'eventual' as never }], 'test')).to.throw(AuthzConfigError, /consistency must be 'cached' or 'fresh'/);
  });
});
