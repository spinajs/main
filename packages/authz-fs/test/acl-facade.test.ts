import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AccessDenied, AuthzConfigError, SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import { renderTemplate } from '@spinajs/log-common';

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
  let warnings: string[];

  beforeEach(async () => {
    child = await configuredChild({ uploads: { mode: 'enforce' }, archive: { mode: 'audit' }, scratch: { mode: 'off' } });
    acl = new MemoryFileAclStore();
    authz = new FakeAuthz();
    principal = userPrincipal('alice');
    warnings = [];
  });

  afterEach(async () => {
    await child.dispose();
  });

  const facade = () =>
    new FsAcl({
      container: child,
      service: async () => authz,
      principal: () => principal,
      log: { warn: (fields: unknown, template?: unknown) => void warnings.push(renderTemplate(template as string, fields as Record<string, unknown>)) },
      store: async () => acl,
    });

  it('grant asserts fs:manage on the normalised path, then writes the row with who granted it', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    await facade().grant('uploads', './docs/', CAROL, 'viewer', { expiresAt, kind: 'dir' });
    expect(authz.calls.map((c) => [c.kind, c.permission, c.resource])).to.deep.equal([['assert', 'fs:manage', 'dir:uploads:docs']]);
    expect(await acl.list('uploads', 'docs')).to.deep.equal([{ fs: 'uploads', path: 'docs', subject: CAROL, relation: 'viewer', expiresAt, grantedBy: 'user:alice' }]);
  });

  it('checks a file ref by default, and the fs ref for the root', async () => {
    await facade().grant('uploads', 'a.txt', TEAM, 'editor');
    await facade().grant('uploads', '', CAROL, 'viewer');
    expect(authz.keys()).to.deep.equal(['fs:manage file:uploads:a.txt', 'fs:manage fs:uploads']);
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

  it('revoke and list need fs:manage too', async () => {
    await acl.grant({ fs: 'uploads', path: 'a.txt', subject: CAROL, relation: 'viewer' });
    expect(await facade().list('uploads', 'a.txt')).to.have.length(1);
    await facade().revoke('uploads', 'a.txt', CAROL, 'viewer');
    expect(acl.rows).to.deep.equal([]);
    expect(authz.keys()).to.deep.equal(['fs:manage file:uploads:a.txt', 'fs:manage file:uploads:a.txt']);
    authz.allow = () => false;
    await expect(facade().list('uploads', 'a.txt')).to.be.rejectedWith(AccessDenied);
  });

  it("mode 'off' and SYSTEM are not checked; audit warns and goes on", async () => {
    authz.allow = () => false;
    await facade().grant('scratch', 'a.txt', CAROL, 'viewer');
    principal = SYSTEM;
    await facade().grant('uploads', 'a.txt', CAROL, 'viewer');
    expect(authz.calls).to.deep.equal([]);
    principal = userPrincipal('alice');
    await facade().grant('archive', 'a.txt', CAROL, 'viewer');
    expect(warnings.some((w) => w.includes('lacks fs:manage on file:archive:a.txt'))).to.equal(true);
    expect(acl.rows.map((r) => r.fs).sort()).to.deep.equal(['archive', 'scratch', 'uploads']);
  });
});
