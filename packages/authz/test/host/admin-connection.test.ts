import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONNECTION } from '@spinajs/authz';

describe('the authz connection alias', () => {
  it('is the ORM alias authz', () => {
    expect(AUTHZ_CONNECTION).to.equal('authz');
  });
});
