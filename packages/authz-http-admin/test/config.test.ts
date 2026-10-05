import 'mocha';
import { expect } from 'chai';

import config from '../src/config/authz-http-admin.js';

describe('shipped configuration', () => {
  const dirs = config.system.dirs.controllers.map((d) => d.replace(/\\/g, '/'));

  it('serves the controllers dir and no longer the 2.x legacy one', () => {
    expect(dirs).to.have.length(1);
    expect(dirs[0]).to.match(/\/authz-http-admin\/lib\/(mjs|cjs)\/controllers$/);
    expect(dirs.filter((d) => d.includes('legacy'))).to.deep.equal([]);
  });

  it('runs the admin routes on the root domain by default', () => {
    expect(config.authz.http.admin.domain).to.equal('root');
  });

  it('keeps the 2.x role guard block that users-http still resolves', () => {
    expect(config.rbac.admin.roleGuard.service).to.equal('DefaultRoleGuard');
  });
});
