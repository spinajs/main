import 'mocha';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import config from '../src/config/authz-http-admin.js';

describe('shipped configuration', () => {
  const dirs = config.system.dirs.controllers.map((d) => d.replace(/\\/g, '/'));

  it('serves the controllers dir and no longer the 2.x legacy one', () => {
    expect(dirs).to.have.length(1);
    expect(dirs[0]).to.match(/\/authz-http-admin\/lib\/(mjs|cjs)\/controllers$/);
    expect(dirs.filter((d) => d.includes('legacy'))).to.deep.equal([]);
  });

  // http loads every file of a controllers dir; a barrel there would hand it the controller twice.
  it('keeps only controller files in the controllers dir', () => {
    expect(readdirSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'controllers'))).to.deep.equal(['AuthzAdminController.ts']);
  });

  it('runs the admin routes on the root domain by default', () => {
    expect(config.authz.http.admin.domain).to.equal('root');
  });

  it('ships no 2.x rbac.* keys', () => {
    expect(config).to.not.have.property('rbac');
  });
});
