import 'mocha';
import { expect } from 'chai';

import usersHttp from '../../src/config/users-http.js';

describe('users-http v3: config fragment', () => {
  // Without them the users:* grants of a role compile to nothing, and no account is ever privileged.
  it('declares the users:* permissions of the admin record routes', () => {
    expect(usersHttp.authz.permissions).to.deep.eq({
      'users:read': { fields: true },
      'users:create': {},
      'users:update': { fields: true },
      'users:delete': {},
    });
  });
});
