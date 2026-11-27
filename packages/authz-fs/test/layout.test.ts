import * as chai from 'chai';
import 'mocha';
import { existsSync, readdirSync } from 'node:fs';

import { ConfigVar } from '@spinajs/configuration';

import fsAclConnection from '../src/config/db.js';
import { FS_ACL_CONNECTION } from '../src/index.js';

const expect = chai.expect;

describe('authz-fs package layout', () => {
  // Configuration loads every module under node_modules/@spinajs/*/lib/config as an app config file (D14).
  it('ships config files only in src/config and lib/config', () => {
    // Relative to the package folder, the cwd of its test run.
    expect(readdirSync('src/config')).to.deep.equal(['db.ts']);
    if (existsSync('lib/config')) expect(readdirSync('lib/config').filter((f) => f.endsWith('.js'))).to.deep.equal(['db.js']);
  });

  it('maps the fs_acl alias, and only it, to a lazy value: the connection authz.fsAcl.connection names when the ORM boots', () => {
    expect(Object.keys(fsAclConnection)).to.deep.equal(['db']);
    expect(Object.keys(fsAclConnection.db)).to.deep.equal(['Aliases']);
    expect(Object.keys(fsAclConnection.db.Aliases)).to.deep.equal([FS_ACL_CONNECTION]);
    expect(fsAclConnection.db.Aliases['authz-fs-acl']).to.be.instanceOf(ConfigVar);
  });
});
