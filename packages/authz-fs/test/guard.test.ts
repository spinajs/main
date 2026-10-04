import * as chai from 'chai';
import 'mocha';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccessDenied, AuthzConfigError, FALSE, SYSTEM, TRUE, resourceKey } from '@spinajs/authz';
import type { CheckInput, Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { fs, fsNative, fsTemp } from '@spinajs/fs';
import type { IFsLocalOptions, IFsTempOptions } from '@spinajs/fs';

import { AuthzFsDecorator, guardFs, isGuardedFs, parseFsAccessConfig } from '../src/index.js';
import type { FsGuardOptions } from '../src/index.js';
import { configuredChild } from './helpers.js';
import { installQuietLog } from './support/log.js';

const expect = chai.expect;

interface CheckCall {
  readonly kind: 'check' | 'assert';
  readonly principal: string;
  readonly permission: Permission;
  readonly resource: string;
}

/** Records every decision it is asked for; allows what `allow` says. */
class FakeAuthz {
  readonly calls: CheckCall[] = [];

  constructor(public allow: (permission: Permission, resource: string) => boolean = () => true) {}

  async check(req: CheckInput): Promise<Decision> {
    return this.decide('check', req.principal, req.permission, req.resource as ResourceRef);
  }

  async assert(principal: Principal, permission: Permission, resource?: ResourceRef | object): Promise<Decision> {
    const d = this.decide('assert', principal, permission, resource as ResourceRef);
    if (!d.allowed) throw new AccessDenied(d);
    return d;
  }

  keys(): string[] {
    return this.calls.map((c) => `${c.permission} ${c.resource}`);
  }

  private decide(kind: CheckCall['kind'], principal: Principal, permission: Permission, resource: ResourceRef): Decision {
    const key = resourceKey(resource);
    this.calls.push({ kind, principal: principal.id, permission, resource: key });
    const allowed = this.allow(permission, key);
    return { allowed, permission, resource, principal: { type: principal.type, id: principal.id }, residual: allowed ? TRUE : FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'root', ...(allowed ? {} : { reason: { code: 'no_access', priority: 900, sortKey: '' } }) } as unknown as Decision;
  }
}

const alice = userPrincipal('alice');

describe('authz-fs guardFs', function () {
  this.timeout(20000);

  let dir: string;
  let child: IContainer;
  let principal: Principal;
  let warnings: string[];
  let undoLog: () => void;

  const local = (name: string, files: Record<string, string> = {}): fsNative<IFsLocalOptions> => {
    const basePath = join(dir, name);
    mkdirSync(basePath, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(basePath, path, '..'), { recursive: true });
      writeFileSync(join(basePath, path), content);
    }
    return new fsNative<IFsLocalOptions>({ name, basePath });
  };

  const guard = <T extends fs>(raw: T, name: string, entry: Record<string, unknown>, authz: FakeAuthz, extra: Partial<FsGuardOptions> = {}): T =>
    guardFs(raw, name, {
      config: parseFsAccessConfig(name, entry),
      container: child,
      service: async () => authz,
      principal: () => principal,
      log: { warn: (m: string) => warnings.push(m) },
      ...extra,
    });

  before(() => {
    undoLog = installQuietLog();
  });

  after(() => {
    undoLog();
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'authz-fs-guard-'));
    child = await configuredChild({ off: { mode: 'off' } });
    principal = alice;
    warnings = [];
  });

  afterEach(async () => {
    await child.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('the proxy', () => {
    it('keeps instanceof, Name and Options.basePath', () => {
      const raw = local('uploads');
      const g = guard(raw, 'uploads', { mode: 'enforce' }, new FakeAuthz());
      expect(g).to.not.equal(raw);
      expect(g instanceof fsNative).to.equal(true);
      expect(g instanceof fs).to.equal(true);
      expect(g.Name).to.equal('uploads');
      expect(g.Options.basePath).to.equal(raw.Options.basePath);
      expect(isGuardedFs(g)).to.equal(true);
      expect(isGuardedFs(raw)).to.equal(false);
    });

    it("is not created for mode 'off'", () => {
      const raw = local('scratch');
      expect(guard(raw, 'scratch', { mode: 'off' }, new FakeAuthz())).to.equal(raw);
    });

    it('guards a frozen instance and its non-configurable own methods too', async () => {
      const raw = local('uploads', { 'a.txt': 'A' });
      Object.defineProperty(raw, 'read', { value: raw.read.bind(raw) });
      Object.freeze(raw);
      const g = guard(raw, 'uploads', { mode: 'enforce' }, new FakeAuthz(() => false));

      let error: unknown;
      await g.read('a.txt').catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AccessDenied);
      expect(Object.keys(g)).to.deep.equal(Object.keys(raw));
      expect(Object.getPrototypeOf(g)).to.equal(Object.getPrototypeOf(raw));
    });

    it('returns the same wrapper for a method on every access', () => {
      const g = guard(local('uploads'), 'uploads', { mode: 'enforce' }, new FakeAuthz());
      expect(g.read).to.equal(g.read);
    });
  });

  describe('enforce', () => {
    it('checks the permission on the normalised ref before the raw call and passes the normalised path', async () => {
      const raw = local('uploads', { 'docs/a.txt': 'A' });
      const authz = new FakeAuthz();
      const g = guard(raw, 'uploads', { mode: 'enforce' }, authz);

      expect(String(await g.read('./docs//a.txt', 'utf-8'))).to.equal('A');
      expect(String(await g.read(join(raw.Options.basePath!, 'docs', 'a.txt'), 'utf-8'))).to.equal('A');
      expect(String(await g.read('/docs/a.txt', 'utf-8'))).to.equal('A');
      expect(authz.calls.map((c) => [c.kind, c.principal, c.permission, c.resource])).to.deep.equal([
        ['assert', 'alice', 'fs:read', 'file:uploads:docs/a.txt'],
        ['assert', 'alice', 'fs:read', 'file:uploads:docs/a.txt'],
        ['assert', 'alice', 'fs:read', 'file:uploads:docs/a.txt'],
      ]);
    });

    it('hands the raw method the path it checked', async () => {
      const raw = local('uploads');
      const seen: unknown[] = [];
      Object.defineProperty(raw, 'exists', { value: async (p: unknown) => (seen.push(p), true) });
      const g = guard(raw, 'uploads', { mode: 'enforce' }, new FakeAuthz());

      await g.exists('\\docs\\.\\a.txt');
      await g.exists(join(raw.Options.basePath!, 'docs', 'b.txt'));
      expect(seen).to.deep.equal(['docs/a.txt', 'docs/b.txt']);
    });

    it('throws AccessDenied and never reaches the raw method when a check fails', async () => {
      const raw = local('uploads', { 'docs/a.txt': 'A' });
      let reached = false;
      Object.defineProperty(raw, 'rm', { value: async () => void (reached = true) });
      const g = guard(raw, 'uploads', { mode: 'enforce' }, new FakeAuthz((p) => p !== 'fs:delete'));

      let error: unknown;
      await g.rm('docs/a.txt').catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AccessDenied);
      expect(reached).to.equal(false);
    });

    it('refuses a path above the root with InvalidArgument, before any check or raw call', async () => {
      const raw = local('uploads');
      let reached = false;
      Object.defineProperty(raw, 'read', { value: async () => void (reached = true) });
      const authz = new FakeAuthz();
      const g = guard(raw, 'uploads', { mode: 'enforce' }, authz);

      for (const bad of ['../x', 'a/../../x', 'C:\\Windows\\win.ini', 'a.txt::$DATA', 'secret.']) {
        let error: unknown;
        await g.read(bad).catch((e: unknown) => (error = e));
        expect(error, bad).to.be.instanceOf(InvalidArgument);
      }
      expect(reached).to.equal(false);
      expect(authz.calls).to.deep.equal([]);
    });

    it('checks the filesystem root as the fs ref and directories as dir refs', async () => {
      const authz = new FakeAuthz();
      const g = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', { mode: 'enforce' }, authz);

      expect(await g.list('/')).to.deep.equal(['docs']);
      await g.mkdir('docs/sub');
      await g.isDir('docs');
      expect(authz.keys()).to.deep.equal(['fs:list fs:uploads', 'fs:write dir:uploads:docs/sub', 'fs:stat dir:uploads:docs']);
    });

    it('checks every permission of a method: move needs read and delete on the source, write on the target', async () => {
      const authz = new FakeAuthz();
      const g = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', { mode: 'enforce' }, authz);

      await g.move('docs/a.txt', 'moved/a.txt');
      expect(authz.keys()).to.deep.equal(['fs:read file:uploads:docs/a.txt', 'fs:delete file:uploads:docs/a.txt', 'fs:write file:uploads:moved/a.txt']);
      expect(await g.exists('moved/a.txt')).to.equal(true);
    });

    it('upload checks destPath, or the basename of srcPath it then passes explicitly', async () => {
      const authz = new FakeAuthz();
      const raw = local('uploads');
      const seen: unknown[][] = [];
      const upload = raw.upload.bind(raw);
      Object.defineProperty(raw, 'upload', { value: async (...args: [string, string?]) => (seen.push(args), upload(...args)) });
      const g = guard(raw, 'uploads', { mode: 'enforce' }, authz);
      const src = join(dir, 'outside', 'local.txt');
      mkdirSync(join(dir, 'outside'));
      writeFileSync(src, 'L');

      await g.upload(src, 'in/up.txt');
      await g.upload(src);
      expect(authz.keys()).to.deep.equal(['fs:write file:uploads:in/up.txt', 'fs:write file:uploads:local.txt']);
      expect(seen).to.deep.equal([
        [src, 'in/up.txt'],
        [src, 'local.txt'],
      ]);
      expect(String(await raw.read('local.txt', 'utf-8'))).to.equal('L');
    });

    it('checks zip sources, also [path, entry] pairs, and keeps the entry names', async () => {
      const authz = new FakeAuthz();
      const g = guard(local('uploads', { 'docs/a.txt': 'A', 'docs/b.txt': 'B' }), 'uploads', { mode: 'enforce' }, authz);

      const result = await g.zip(['docs/a.txt', ['./docs/b.txt', 'renamed.txt']], g, 'out.zip');
      expect(result.asFilePath()).to.match(/out\.zip$/);
      expect(authz.keys()).to.deep.equal(['fs:read file:uploads:docs/a.txt', 'fs:read file:uploads:docs/b.txt', 'fs:write file:uploads:out.zip']);
    });

    it('names the archive itself when zip gets a dstFs without dstFile, and checks that name', async () => {
      const authz = new FakeAuthz();
      const g = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', { mode: 'enforce' }, authz);

      const result = await g.zip(['docs/a.txt'], g);
      const written = authz.calls[1].resource;
      expect(written).to.match(/^file:uploads:[0-9a-f-]+\.zip$/);
      expect(result.asFilePath().endsWith(written.slice('file:uploads:'.length))).to.equal(true);
    });

    it('refuses a zip or unzip that names a destination without dstFs, unless SYSTEM', async () => {
      const g = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', { mode: 'enforce' }, new FakeAuthz());

      let error: unknown;
      await g.zip(['docs/a.txt'], undefined, 'out.zip').catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message)
        .to.contain('uploads')
        .and.contain('zip');

      error = undefined;
      await g.unzip('a.zip', 'unz').catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.contain('unzip');
    });

    it('checks only the sources of a zip without dstFs and without a name (the provider picks a fresh temp file)', async () => {
      const authz = new FakeAuthz();
      const raw = local('uploads', { 'docs/a.txt': 'A' });
      const seen: unknown[][] = [];
      Object.defineProperty(raw, 'zip', { value: async (...args: unknown[]) => void seen.push(args) });
      const g = guard(raw, 'uploads', { mode: 'enforce' }, authz);

      await g.zip('docs/a.txt');
      expect(authz.keys()).to.deep.equal(['fs:read file:uploads:docs/a.txt']);
      expect(seen).to.deep.equal([['docs/a.txt']]);
    });
  });

  describe('audit', () => {
    it('decides, warns on a denial and allows', async () => {
      const authz = new FakeAuthz(() => false);
      const g = guard(local('archive', { 'docs/a.txt': 'A' }), 'archive', { mode: 'audit' }, authz);

      expect(String(await g.read('docs/a.txt', 'utf-8'))).to.equal('A');
      expect(authz.calls.map((c) => c.kind)).to.deep.equal(['check']);
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.contain('archive').and.contain('fs:read').and.contain('file:archive:docs/a.txt').and.contain('alice');
    });

    it('does not warn when the check allows', async () => {
      const g = guard(local('archive', { 'docs/a.txt': 'A' }), 'archive', { mode: 'audit' }, new FakeAuthz());
      await g.read('docs/a.txt');
      expect(warnings).to.deep.equal([]);
    });

    it('still refuses a path above the root', async () => {
      const g = guard(local('archive'), 'archive', { mode: 'audit' }, new FakeAuthz());
      let error: unknown;
      await g.read('../x').catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(InvalidArgument);
    });
  });

  describe('unmapped and unchecked members', () => {
    const withCompact = (name: string) => {
      const raw = local(name);
      Object.defineProperty(raw, 'compact', { value: () => 'compacted' });
      return raw as fsNative<IFsLocalOptions> & { compact(): string };
    };

    it('enforce: an unmapped method throws AuthzConfigError naming fs and method, unless SYSTEM', () => {
      const g = guard(withCompact('uploads'), 'uploads', { mode: 'enforce' }, new FakeAuthz());
      expect(() => g.compact()).to.throw(AuthzConfigError, /uploads.*compact|compact.*uploads/);
      principal = SYSTEM;
      expect(g.compact()).to.equal('compacted');
    });

    it('audit: an unmapped method warns and runs', () => {
      const g = guard(withCompact('archive'), 'archive', { mode: 'audit' }, new FakeAuthz());
      expect(g.compact()).to.equal('compacted');
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.contain('compact');
    });

    it('authz.fs.<name>.operations maps a method, checked on argument 0 as a file', async () => {
      const authz = new FakeAuthz();
      const raw = local('uploads');
      Object.defineProperty(raw, 'compact', { value: async (p: string) => `compacted ${p}` });
      const g = guard(raw, 'uploads', { mode: 'enforce', operations: { compact: ['fs:write', 'fs:delete'] } }, authz) as typeof raw & { compact(p: string): Promise<string> };

      expect(await g.compact('./docs/x')).to.equal('compacted docs/x');
      expect(authz.keys()).to.deep.equal(['fs:write file:uploads:docs/x', 'fs:delete file:uploads:docs/x']);
    });

    it('resolvePath, tmppath, tmpname, lifecycle and Object.prototype members are not checked', async () => {
      const authz = new FakeAuthz(() => false);
      const raw = local('uploads');
      const g = guard(raw, 'uploads', { mode: 'enforce' }, authz);

      expect(g.resolvePath('a.txt')).to.equal(raw.resolvePath('a.txt'));
      expect(g.tmppath('.x')).to.match(/\.x$/);
      expect(g.tmpname()).to.be.a('string');
      expect(g.__checkInstance__([{ name: 'uploads' }])).to.equal(true);
      expect(g.ServiceName).to.equal('uploads');
      expect(g.hasOwnProperty('Options')).to.equal(true);
      expect(String(g)).to.be.a('string');
      expect(g.constructor).to.equal(fsNative);
      await g.resolve();
      expect(authz.calls).to.deep.equal([]);
    });
  });

  describe('list', () => {
    it("default 'dir': only fs:list on the directory", async () => {
      const authz = new FakeAuthz((p) => p === 'fs:list');
      const g = guard(local('uploads', { 'docs/a.txt': 'A', 'docs/b.txt': 'B' }), 'uploads', { mode: 'enforce' }, authz);
      expect((await g.list('docs')).sort()).to.deep.equal(['a.txt', 'b.txt']);
      expect(authz.keys()).to.deep.equal(['fs:list dir:uploads:docs']);
    });

    it("'each' drops the entries without fs:stat", async () => {
      const authz = new FakeAuthz((p, r) => p === 'fs:list' || r === 'file:uploads:docs/b.txt');
      const g = guard(local('uploads', { 'docs/a.txt': 'A', 'docs/b.txt': 'B' }), 'uploads', { mode: 'enforce', list: 'each' }, authz);
      expect(await g.list('docs')).to.deep.equal(['b.txt']);
      expect(authz.keys().sort()).to.deep.equal(['fs:list dir:uploads:docs', 'fs:stat file:uploads:docs/a.txt', 'fs:stat file:uploads:docs/b.txt']);
    });

    it("'each' in audit mode keeps every entry and warns about the denied ones", async () => {
      const authz = new FakeAuthz((p, r) => p === 'fs:list' || r === 'file:uploads:b.txt');
      const g = guard(local('uploads', { 'a.txt': 'A', 'b.txt': 'B' }), 'uploads', { mode: 'audit', list: 'each' }, authz);
      expect((await g.list('')).sort()).to.deep.equal(['a.txt', 'b.txt']);
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.contain('file:uploads:a.txt');
    });
  });

  describe('nested calls and other filesystems', () => {
    it('copy to another guarded filesystem checks the destination there, and its nested upload is not checked again', async () => {
      const src = new FakeAuthz();
      const dst = new FakeAuthz();
      const uploads = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', { mode: 'enforce' }, src);
      const archiveRaw = local('archive');
      const archive = guard(archiveRaw, 'archive', { mode: 'enforce' }, dst);

      await uploads.copy('docs/a.txt', './kept/a.txt', archive);
      expect(src.keys()).to.deep.equal(['fs:read file:uploads:docs/a.txt']);
      expect(dst.keys()).to.deep.equal(['fs:write file:archive:kept/a.txt']);
      expect(String(await archiveRaw.read('kept/a.txt', 'utf-8'))).to.equal('A');
    });

    it('a denied destination on another filesystem stops the call before the raw method', async () => {
      const uploadsRaw = local('uploads', { 'docs/a.txt': 'A' });
      const uploads = guard(uploadsRaw, 'uploads', { mode: 'enforce' }, new FakeAuthz());
      const archive = guard(local('archive'), 'archive', { mode: 'enforce' }, new FakeAuthz(() => false));

      let error: unknown;
      await uploads.move('docs/a.txt', 'a.txt', archive).catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AccessDenied);
      expect(await uploadsRaw.exists('docs/a.txt')).to.equal(true);
    });

    it('the destination uses its own mode: audit there warns and allows', async () => {
      const uploads = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', { mode: 'enforce' }, new FakeAuthz());
      const archive = guard(local('archive'), 'archive', { mode: 'audit' }, new FakeAuthz(() => false));

      await uploads.copy('docs/a.txt', 'a.txt', archive);
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.contain('file:archive:a.txt');
    });

    it("a raw destination is checked with its filesystem's config; mode 'off' there means no check", async () => {
      const src = new FakeAuthz();
      const uploads = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', { mode: 'enforce' }, src);
      const offRaw = local('off');

      await uploads.copy('docs/a.txt', 'copied.txt', offRaw);
      expect(await offRaw.exists('copied.txt')).to.equal(true);
      expect(src.keys()).to.deep.equal(['fs:read file:uploads:docs/a.txt']);
    });

    it('a raw destination of a guarded filesystem is checked in that filesystem', async () => {
      const cfgChild = await configuredChild({ archive: { mode: 'enforce' } });
      try {
        const src = new FakeAuthz();
        const uploads = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', { mode: 'enforce' }, src, { container: cfgChild });
        await uploads.copy('docs/a.txt', 'kept.txt', local('archive'));
        expect(src.keys()).to.deep.equal(['fs:read file:uploads:docs/a.txt', 'fs:write file:archive:kept.txt']);
      } finally {
        await cfgChild.dispose();
      }
    });

    it('a call nested in an authorised operation is not re-checked: zip writes through the guarded dstFs once', async () => {
      const src = new FakeAuthz();
      const dst = new FakeAuthz((p) => p === 'fs:write');
      const uploads = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', { mode: 'enforce' }, src);
      const archive = guard(local('archive'), 'archive', { mode: 'enforce' }, dst);

      await uploads.zip(['docs/a.txt'], archive, 'a.zip');
      expect(dst.keys()).to.deep.equal(['fs:write file:archive:a.zip']);

      dst.calls.length = 0;
      const out = await uploads.zip(['docs/a.txt'], archive, 'b.zip');
      expect(out.fs).to.equal(archive);
      expect(dst.keys()).to.deep.equal(['fs:write file:archive:b.zip']);
    });

    it('fsTemp over a guarded backend: the guarded temp is checked once, its backend calls pass inside the operation', async () => {
      const backendAuthz = new FakeAuthz(() => false);
      const tempAuthz = new FakeAuthz();
      const backend = guard(local('backend', { 'docs/a.txt': 'A' }), 'backend', { mode: 'enforce' }, backendAuthz);
      const rawTemp = new fsTemp({ name: 'temp', provider: 'backend', cleanup: false } as IFsTempOptions);
      Object.defineProperty(rawTemp, 'Provider', { value: backend });
      const temp = guard(rawTemp, 'temp', { mode: 'enforce' }, tempAuthz);

      expect(String(await temp.read('docs/a.txt', 'utf-8'))).to.equal('A');
      expect(tempAuthz.keys()).to.deep.equal(['fs:read file:temp:docs/a.txt']);
      expect(backendAuthz.calls).to.deep.equal([]);

      let error: unknown;
      await rawTemp.read('docs/a.txt').catch((e: unknown) => (error = e));
      expect(error, 'an unguarded temp reaches the guarded backend, which checks').to.be.instanceOf(AccessDenied);
      expect(backendAuthz.keys()).to.deep.equal(['fs:read file:backend:docs/a.txt']);
    });

    it('the bypass ends with the operation: a guarded call from a stream callback is checked', async () => {
      const authz = new FakeAuthz((_p, r) => r !== 'file:uploads:secret.txt');
      const g = guard(local('uploads', { 'a.txt': 'A', 'secret.txt': 'S' }), 'uploads', { mode: 'enforce' }, authz);

      const stream = await g.readStream('a.txt');
      const nested = await new Promise<unknown>((resolve) => {
        stream.on('data', () => {
          g.read('secret.txt').then(resolve, resolve);
        });
        stream.resume();
      });
      expect(nested).to.be.instanceOf(AccessDenied);
    });

    it('concurrent operations do not share a bypass', async () => {
      const authz = new FakeAuthz((_p, r) => r !== 'file:uploads:secret.txt');
      const g = guard(local('uploads', { 'a.txt': 'A', 'secret.txt': 'S' }), 'uploads', { mode: 'enforce' }, authz);
      const results = await Promise.allSettled([g.read('a.txt'), g.read('secret.txt'), g.read('a.txt')]);
      expect(results.map((r) => r.status)).to.deep.equal(['fulfilled', 'rejected', 'fulfilled']);
    });
  });

  describe('AuthzFsDecorator', () => {
    it('is the @spinajs/fs FsDecorator with order 100', async () => {
      const { FsDecorator } = await import('@spinajs/fs');
      const d = new AuthzFsDecorator(child);
      expect(d).to.be.instanceOf(FsDecorator);
      expect(d.order).to.equal(100);
    });

    it('returns the raw instance without an entry or with mode off, else a guard', async () => {
      const cfg = await configuredChild({ uploads: { mode: 'enforce' }, archive: { mode: 'audit' }, scratch: { mode: 'off' } });
      try {
        const d = new AuthzFsDecorator(cfg);
        for (const [name, guarded] of [
          ['uploads', true],
          ['archive', true],
          ['scratch', false],
          ['plain', false],
        ] as const) {
          const raw = local(name);
          const out = d.decorate(raw, { name, service: 'fsNative' });
          expect(out === raw, name).to.equal(!guarded);
          expect(isGuardedFs(out), name).to.equal(guarded);
        }
      } finally {
        await cfg.dispose();
      }
    });

    it('fails on an invalid entry', async () => {
      const cfg = await configuredChild({ uploads: { mode: 'enforced' } });
      try {
        expect(() => new AuthzFsDecorator(cfg).decorate(local('uploads'), { name: 'uploads', service: 'fsNative' })).to.throw(AuthzConfigError, /authz\.fs\.uploads\.mode/);
      } finally {
        await cfg.dispose();
      }
    });
  });
});
