import * as chai from 'chai';
import 'mocha';

import dbConfig from '../../src/config/db.js';

const expect = chai.expect;

describe('authz-abac: db.Aliases.authz default', () => {
  it('maps the alias to the default connection', () => {
    expect(dbConfig).to.deep.equal({ db: { Aliases: { authz: 'default' } } });
  });
});
