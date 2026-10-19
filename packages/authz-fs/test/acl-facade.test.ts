import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AccessDenied, AuthzConfigError, SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import { FILE_PROVIDER_INSTANCES } from '@spinajs/fs';

import { FsAcl } from '../src/index.js';
import { configuredChild } from './helpers.js';
import { TEAM } from './support/acl-contract.js';
import { FakeAuthz } from './support/fake-authz.js';
import { MemoryFileAclStore } from './support/memory-acl-store.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const CAROL = { type: 'user', id: 'carol' };

describe('authz-fs FsAcl', () => {
  let child: IContainer;
  let acl: MemoryFileAclStore;
  let authz: FakeAuthz;
  let principal: Principal;

  beforeEach(async () => {
    child = await configuredChild({ uploads: { mode: 'enforce' }, archive: { mode: 'audit' }, scratch: { mode: 'off' } });
    for (const name of ['uploads', 'archive', 'scratch', 'bare']) child.register({ Name: name, BasePath: '' }).asMapValue(FILE_PROVIDER_INSTANCES, name);
    acl = new MemoryFileAclStore();
    authz = new FakeAuthz();
    principal = userPrincipal('alice');
  });

  afterEach(async () => {
    await child.dispose();
  });

  const facade = () =>
    new FsAcl({
      container: child,
      service: async () => authz,
      principal: () => principal,
      log: { warn: () => undefined },
      store: async () => acl,
    });

  it('grant asserts fs:manage on the normalised path, then writes the row with who granted it', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    await facade().grant('uploads', './docs/', CAROL, 'viewer', { expiresAt });
    expect(authz.calls.map((c) => [c.kind, c.permission, c.resource])).to.deep.equal([
      ['assert', 'fs:manage', 'file:uploads:docs'],
      ['assert', 'fs:manage', 'dir:uploads:docs'],
    ]);
    expect(await acl.list('uploads', 'docs')).to.deep.equal([{ fs: 'uploads', path: 'docs', subject: CAROL, relation: 'viewer', expiresAt, grantedBy: 'user:alice' }]);
  });

  it('checks the fs ref once for the root, also when the path normalises to it', async () => {
    await facade().grant('uploads', '', CAROL, 'viewer');
    await facade().grant('uploads', './a/..', CAROL, 'editor');
    expect(authz.keys()).to.deep.equal(['fs:manage fs:uploads', 'fs:manage fs:uploads']);
  });

  it('needs fs:manage on both the file and the dir ref', async () => {
    for (const only of ['file:uploads:a.txt', 'dir:uploads:a.txt']) {
      authz.allow = (_p, resource) => resource === only;
      await expect(facade().grant('uploads', 'a.txt', CAROL, 'viewer'), only).to.be.rejectedWith(AccessDenied);
    }
    expect(acl.rows).to.deep.equal([]);
  });

  it('a denial is AccessDenied and changes nothing', async () => {
    authz.allow = () => false;
    await expect(facade().grant('uploads', 'a.txt', CAROL, 'viewer')).to.be.rejectedWith(AccessDenied);
    expect(acl.rows).to.deep.equal([]);
  });

  it('refuses a relation authz.fsAcl.relations does not name, before any check', async () => {
    await expect(facade().grant('uploads', 'a.txt', CAROL, 'reviewer')).to.be.rejectedWith(AuthzConfigError, 'authz.fsAcl.relations');
    await expect(facade().revoke('uploads', 'a.txt', CAROL, 'reviewer')).to.be.rejectedWith(AuthzConfigError);
    expect(authz.calls).to.deep.equal([]);
  });

  it('refuses a filesystem with no published provider, before any check', async () => {
    await expect(facade().grant('ghost', 'a.txt', CAROL, 'viewer')).to.be.rejectedWith(AuthzConfigError, 'ghost');
    expect(authz.calls).to.deep.equal([]);
  });

  it('revoke of a set subject round-trips', async () => {
    await facade().grant('uploads', 'a.txt', TEAM, 'editor');
    expect(acl.rows).to.have.length(1);
    await facade().revoke('uploads', 'a.txt', TEAM, 'editor');
    expect(acl.rows).to.deep.equal([]);
  });

  it('revoke and list need fs:manage too', async () => {
    await acl.grant({ fs: 'uploads', path: 'a.txt', subject: CAROL, relation: 'viewer' });
    expect(await facade().list('uploads', 'a.txt')).to.have.length(1);
    await facade().revoke('uploads', 'a.txt', CAROL, 'viewer');
    expect(acl.rows).to.deep.equal([]);
    expect(authz.keys()).to.deep.equal(['fs:manage file:uploads:a.txt', 'fs:manage dir:uploads:a.txt', 'fs:manage file:uploads:a.txt', 'fs:manage dir:uploads:a.txt']);
    authz.allow = () => false;
    await expect(facade().list('uploads', 'a.txt')).to.be.rejectedWith(AccessDenied);
  });

  it("denies whatever the mode: 'off', 'audit' and a missing authz.fs entry", async () => {
    authz.allow = () => false;
    for (const fs of ['scratch', 'archive', 'bare']) {
      await expect(facade().grant(fs, 'a.txt', CAROL, 'viewer'), fs).to.be.rejectedWith(AccessDenied);
      await expect(facade().list(fs, 'a.txt'), fs).to.be.rejectedWith(AccessDenied);
    }
    expect(acl.rows).to.deep.equal([]);
  });

  it('SYSTEM is not checked', async () => {
    authz.allow = () => false;
    principal = SYSTEM;
    await facade().grant('scratch', 'a.txt', CAROL, 'viewer');
    expect(authz.calls).to.deep.equal([]);
    expect(acl.rows).to.have.length(1);
  });
});
