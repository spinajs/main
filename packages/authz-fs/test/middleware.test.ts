import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AccessDenied, AuthzConfigError, AuthzDomains, AuthzService, SYSTEM } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { Container, DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { FsMiddleware } from '@spinajs/fs';
import type { fs } from '@spinajs/fs';

import { AuthzFsMiddleware } from '../src/index.js';
import { configuredChild } from './helpers.js';
import { FakeAuthz } from './support/fake-authz.js';
import { useMiddleware } from './support/mw-setup.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const ENTRIES = {
  'mw-up': { mode: 'enforce' },
  'mw-audit': { mode: 'audit' },
  'mw-off': { mode: 'off' },
  'mw-each': { mode: 'enforce', list: 'each' },
  'mw-each-audit': { mode: 'audit', list: 'each' },
};
const FILES = { 'docs/a.txt': 'A', 'docs/b.txt': 'B' };
const named = (Name: string) => ({ Name }) as unknown as fs;

class FsMwHostService {}

describe('authz-fs AuthzFsMiddleware: registration', () => {
  it('is the FsMiddleware of order 100 that authz-fs registers in root', () => {
    expect(new AuthzFsMiddleware()).to.be.instanceOf(FsMiddleware);
    expect(new AuthzFsMiddleware().order).to.equal(100);
    expect(DI.RootContainer.getRegisteredTypes(FsMiddleware)).to.include(AuthzFsMiddleware);
  });

  it('is off for every filesystem when neither a Configuration nor an authz host is resolved', () => {
    expect(new AuthzFsMiddleware({ container: new Container() }).isEnabled(named('mw-up'))).to.equal(false);
  });

  it('fails closed when an authz host is resolved without a Configuration', async () => {
    const host = new Container();
    host.register(FsMwHostService).as(AuthzService);
    await host.resolve(AuthzService);
    expect(() => new AuthzFsMiddleware({ container: host }).isEnabled(named('mw-up'))).to.throw(AuthzConfigError, /Configuration/);
  });

  it("is enabled per filesystem: off for mode 'off' and for a filesystem without an entry", async () => {
    const child = await configuredChild(ENTRIES);
    const mw = new AuthzFsMiddleware({ container: child });
    expect(['mw-up', 'mw-audit', 'mw-off', 'mw-plain'].map((name) => mw.isEnabled(named(name)))).to.deep.equal([true, true, false, false]);
    await child.dispose();
  });
});

describe('authz-fs AuthzFsMiddleware: checks', function () {
  this.timeout(20000);
  const s = useMiddleware(ENTRIES);

  it('enforce: checks the normalised ref with its row as the subject before the IO', async () => {
    const up = s.local('mw-up', FILES);
    expect(String(await up.read('./docs/../docs/a.txt', 'utf-8'))).to.equal('A');
    expect(s.authz.calls.map((c) => [c.kind, c.principal, c.permission, c.resource, c.subject])).to.deep.equal([['assert', 'alice', 'fs:read', 'file:mw-up:docs/a.txt', { id: 'mw-up:docs/a.txt', type: 'file', fs: 'mw-up', path: 'docs/a.txt' }]]);
  });

  it('enforce: a denial is AccessDenied and the provider never runs', async () => {
    const up = s.local('mw-up');
    s.authz.allow = () => false;
    await expect(up.write('new.txt', 'x')).to.be.rejectedWith(AccessDenied);
    expect(existsSync(join(s.dir, 'mw-up', 'new.txt'))).to.equal(false);
  });

  it('enforce: a permit with a residual left is AccessDenied (needs_subject)', async () => {
    const up = s.local('mw-up', FILES);
    s.authz.allow = () => 'conditional';
    const e = await up.read('docs/a.txt').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).to.be.instanceOf(AccessDenied);
    expect((e as AccessDenied).decision.reason?.code).to.equal('needs_subject');
  });

  it('audit: a denial or a conditional permit warns and the IO runs', async () => {
    const audit = s.local('mw-audit', FILES);
    for (const answer of [false, 'conditional'] as const) {
      s.warnings.length = 0;
      s.authz.allow = () => answer;
      expect(String(await audit.read('docs/a.txt', 'utf-8'))).to.equal('A');
      expect(s.warnings, String(answer)).to.have.length(1);
      expect(s.warnings[0]).to.match(/^authz\.fs\.mw-audit: user:alice lacks fs:read on file:mw-audit:docs\/a\.txt/);
    }
  });

  it("mode 'off' and a filesystem without an entry are not checked", async () => {
    s.authz.allow = () => false;
    for (const name of ['mw-off', 'mw-plain']) expect(String(await s.local(name, FILES).read('docs/a.txt', 'utf-8')), name).to.equal('A');
    expect(s.authz.calls).to.deep.equal([]);
  });

  it('checks the filesystem root as the fs ref and a directory as a dir ref', async () => {
    const up = s.local('mw-up', FILES);
    await up.list('/');
    await up.isDir('docs');
    expect(s.authz.keys()).to.deep.equal(['fs:list fs:mw-up', 'fs:stat dir:mw-up:docs']);
  });

  it('move needs read and delete on the source and write on the destination', async () => {
    await s.local('mw-up', FILES).move('docs/a.txt', 'moved.txt');
    expect(s.authz.keys()).to.deep.equal(['fs:read file:mw-up:docs/a.txt', 'fs:delete file:mw-up:docs/a.txt', 'fs:write file:mw-up:moved.txt']);
  });

  it('each target is checked with the config of its own filesystem: off is not checked, audit warns', async () => {
    const up = s.local('mw-up', FILES);
    s.authz.allow = (permission) => permission !== 'fs:write';
    await up.copy('docs/a.txt', 'a.txt', s.local('mw-off'));
    expect(s.authz.keys()).to.deep.equal(['fs:read file:mw-up:docs/a.txt']);
    await up.copy('docs/a.txt', 'a.txt', s.local('mw-audit'));
    expect(s.warnings.some((w) => w.includes('lacks fs:write on file:mw-audit:a.txt'))).to.equal(true);
    expect(existsSync(join(s.dir, 'mw-audit', 'a.txt'))).to.equal(true);
  });

  it('a denied destination on another filesystem stops the copy before the IO', async () => {
    const up = s.local('mw-up', FILES);
    s.authz.allow = (permission, resource) => !(permission === 'fs:write' && resource.startsWith('file:mw-each'));
    await expect(up.copy('docs/a.txt', 'a.txt', s.local('mw-each'))).to.be.rejectedWith(AccessDenied);
    expect(existsSync(join(s.dir, 'mw-each', 'a.txt'))).to.equal(false);
  });

  it('SYSTEM passes without a check', async () => {
    s.principal = SYSTEM;
    s.authz.allow = () => false;
    await s.local('mw-up').write('sys.txt', 'x');
    expect(s.authz.calls).to.deep.equal([]);
    expect(existsSync(join(s.dir, 'mw-up', 'sys.txt'))).to.equal(true);
  });

  it('a write path longer than the ACL holds is InvalidArgument before any check or IO, also for SYSTEM', async () => {
    const up = s.local('mw-up');
    const long = `${'d'.repeat(200)}/${'d'.repeat(200)}/${'f'.repeat(120)}.txt`;
    await expect(up.write(long, 'x')).to.be.rejectedWith(InvalidArgument);
    s.principal = SYSTEM;
    await expect(up.write(long, 'x')).to.be.rejectedWith(InvalidArgument);
    expect(s.authz.calls).to.deep.equal([]);
  });

  it("default list 'dir' checks only fs:list on the directory", async () => {
    expect((await s.local('mw-up', FILES).list('docs')).sort()).to.deep.equal(['a.txt', 'b.txt']);
    expect(s.authz.keys()).to.deep.equal(['fs:list dir:mw-up:docs']);
  });

  it("list 'each': enforce drops the entries without a definite fs:stat, audit keeps them and warns", async () => {
    s.authz.allow = (permission, resource) => permission !== 'fs:stat' || resource.endsWith('docs/a.txt');
    expect(await s.local('mw-each', FILES).list('docs')).to.deep.equal(['a.txt']);
    expect((await s.local('mw-each-audit', FILES).list('docs')).sort()).to.deep.equal(['a.txt', 'b.txt']);
    expect(s.warnings.filter((w) => w.includes('lacks fs:stat'))).to.have.length(1);
  });

  it("list 'each' drops an entry whose fs:stat is conditional", async () => {
    s.authz.allow = (permission) => (permission === 'fs:stat' ? 'conditional' : true);
    expect(await s.local('mw-each', FILES).list('docs')).to.deep.equal([]);
  });

  it("list 'each' does not filter for SYSTEM", async () => {
    s.principal = SYSTEM;
    s.authz.allow = () => false;
    expect((await s.local('mw-each', FILES).list('docs')).sort()).to.deep.equal(['a.txt', 'b.txt']);
  });
});

describe('authz-fs AuthzFsMiddleware: the service of a domain', function () {
  this.timeout(20000);
  const s = useMiddleware({ 'mw-up': { mode: 'enforce' }, 'mw-dom': { mode: 'enforce', domain: 'files' }, 'mw-gone': { mode: 'enforce', domain: 'missing' } });

  it("asks the root AuthzService for domain 'root' and AuthzDomains.service for another, which must exist", async () => {
    const root = new FakeAuthz();
    const files = new FakeAuthz();
    const asked: string[] = [];
    s.child.register(testHost.instance(root as unknown as AuthzService)).as(AuthzService);
    const domains = {
      service: async (name: string) => {
        asked.push(name);
        if (name !== 'files') throw new AuthzConfigError(`Authz domain "${name}" does not exist`);
        return files as unknown as AuthzService;
      },
    } as unknown as AuthzDomains;
    s.child.register(testHost.instance(domains)).as(AuthzDomains);
    s.use(new AuthzFsMiddleware({ container: s.child, principal: () => s.principal, store: async () => s.acl }));

    await s.local('mw-up', { 'a.txt': 'A' }).read('a.txt');
    await s.local('mw-dom', { 'a.txt': 'A' }).read('a.txt');
    await expect(s.local('mw-gone', { 'a.txt': 'A' }).read('a.txt')).to.be.rejectedWith(AuthzConfigError);
    expect(root.keys()).to.deep.equal(['fs:read file:mw-up:a.txt']);
    expect(files.keys()).to.deep.equal(['fs:read file:mw-dom:a.txt']);
    expect(asked).to.deep.equal(['files', 'missing']);
  });
});
