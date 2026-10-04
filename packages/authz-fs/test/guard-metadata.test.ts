import * as chai from 'chai';
import 'mocha';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { AccessDenied, AuthzConfigError, SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import { fsNative } from '@spinajs/fs';
import type { IFsLocalOptions, fs } from '@spinajs/fs';

import { FileMetadataStore, guardFs, parseFsAccessConfig } from '../src/index.js';
import type { FsGuardOptions } from '../src/index.js';
import { configuredChild } from './helpers.js';
import { FakeAuthz } from './support/fake-authz.js';
import { installQuietLog } from './support/log.js';
import { MemoryFileMetadataStore } from './support/memory-store.js';

const expect = chai.expect;

class ArchiveMetadataStore extends MemoryFileMetadataStore {}

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const STAMPED = { mode: 'enforce', metadata: 'MemoryFileMetadataStore', stampOwner: true };

const closed = (stream: Writable): Promise<void> => new Promise((resolve, reject) => stream.once('close', resolve).once('error', reject));

describe('authz-fs guard: metadata and owner stamping (D10)', function () {
  this.timeout(20000);

  let dir: string;
  let child: IContainer;
  let principal: Principal;
  let store: MemoryFileMetadataStore;
  let archiveStore: ArchiveMetadataStore;
  let errors: string[];
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

  const guard = <T extends fs>(raw: T, name: string, entry: Record<string, unknown>, authz: FakeAuthz = new FakeAuthz(), extra: Partial<FsGuardOptions> = {}): T =>
    guardFs(raw, name, {
      config: parseFsAccessConfig(name, entry),
      container: child,
      service: async () => authz,
      principal: () => principal,
      log: { warn: () => undefined, error: (m: string) => errors.push(m) },
      ...extra,
    });

  const at = (name: string): string => join(dir, name);

  before(() => {
    undoLog = installQuietLog();
  });

  after(() => {
    undoLog();
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'authz-fs-meta-'));
    child = await configuredChild({ archive: { mode: 'enforce', metadata: 'ArchiveMetadataStore', stampOwner: true }, plain: { mode: 'enforce' }, off: { mode: 'off' } });
    store = new MemoryFileMetadataStore();
    archiveStore = new ArchiveMetadataStore();
    child.register(testHost.instance(store)).as(FileMetadataStore);
    child.register(testHost.instance(archiveStore)).as(FileMetadataStore);
    principal = alice;
    errors = [];
  });

  afterEach(async () => {
    await child.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('stamping', () => {
    it('write stamps the principal as the owner', async () => {
      const g = guard(local('uploads'), 'uploads', STAMPED);
      await g.write('a.txt', 'x');
      expect(store.owner('uploads', 'a.txt')).to.equal('user:alice');
    });

    it('stamps the principal the decision ran for (the inherit delegate), not the agent', async () => {
      principal = { ...userPrincipal('agent-7'), type: 'agent', onBehalfOf: bob, delegation: 'inherit' } as Principal;
      const g = guard(local('uploads'), 'uploads', STAMPED, new FakeAuthz(undefined, () => ({ type: 'user', id: 'bob' })));
      await g.write('a.txt', 'x');
      expect(store.owner('uploads', 'a.txt')).to.equal('user:bob');
    });

    it('SYSTEM, UNATTENDED and anonymous principals stamp nothing', async () => {
      const g = guard(local('uploads'), 'uploads', { ...STAMPED, mode: 'audit' });
      for (const [p, path] of [
        [SYSTEM, 'system.txt'],
        [UNATTENDED, 'unattended.txt'],
        [{ ...userPrincipal('anonymous'), type: 'anonymous', authenticated: false }, 'anon.txt'],
      ] as const) {
        principal = p as Principal;
        await g.write(path, 'x');
        expect(store.owner('uploads', path), path).to.equal(undefined);
      }
      expect(store.calls.filter((c) => c.startsWith('set'))).to.deep.equal([]);
    });

    it('without stampOwner stamps nothing, but rm and move still keep the store in step', async () => {
      const g = guard(local('uploads', { 'a.txt': 'A', 'b.txt': 'B' }), 'uploads', { mode: 'enforce', metadata: 'MemoryFileMetadataStore' });
      await g.write('new.txt', 'x');
      expect(store.owner('uploads', 'new.txt')).to.equal(undefined);
      await store.set('uploads', 'a.txt', { owner: bob });
      await store.set('uploads', 'b.txt', { owner: bob });
      await g.move('a.txt', 'moved.txt');
      await g.rm('b.txt');
      expect(store.owner('uploads', 'moved.txt')).to.equal('user:bob');
      expect(store.owner('uploads', 'a.txt')).to.equal(undefined);
      expect(store.owner('uploads', 'b.txt')).to.equal(undefined);
    });

    it('an overwrite makes the writer the owner and keeps scope and tags; a SYSTEM overwrite keeps the owner', async () => {
      const g = guard(local('uploads', { 'a.txt': 'A' }), 'uploads', STAMPED);
      await store.set('uploads', 'a.txt', { owner: bob, scope: { type: 'project', id: 'p1' }, tags: ['t'] });
      await g.write('a.txt', 'x');
      expect(await store.get('uploads', 'a.txt')).to.deep.equal({ owner: { type: 'user', id: 'alice' }, scope: { type: 'project', id: 'p1' }, tags: ['t'] });
      principal = SYSTEM;
      await g.write('a.txt', 'y');
      expect(store.owner('uploads', 'a.txt')).to.equal('user:alice');
    });

    it('append stamps a file it creates and keeps the first owner of an existing one', async () => {
      const g = guard(local('uploads', { 'old.txt': 'O' }), 'uploads', STAMPED);
      await store.set('uploads', 'old.txt', { owner: bob });
      await g.append('old.txt', 'more');
      await g.append('new.txt', 'first');
      principal = bob;
      await g.append('new.txt', 'second');
      expect(store.owner('uploads', 'old.txt')).to.equal('user:bob');
      expect(store.owner('uploads', 'new.txt')).to.equal('user:alice');
    });

    it('append to an existing file without an owner does not make the appender its owner', async () => {
      const g = guard(local('uploads', { 'system.log': 'S' }), 'uploads', STAMPED);
      await g.append('system.log', 'line');
      expect(store.owner('uploads', 'system.log')).to.equal(undefined);
    });

    it('mkdir stamps a directory it creates, not an existing one', async () => {
      const g = guard(local('uploads', { 'old/x.txt': 'X' }), 'uploads', STAMPED);
      await g.mkdir('old');
      await g.mkdir('fresh/inner');
      expect(store.owner('uploads', 'old')).to.equal(undefined);
      expect(store.owner('uploads', 'fresh/inner')).to.equal('user:alice');
      expect(store.owner('uploads', 'fresh')).to.equal(undefined);
    });

    it('upload stamps the destination, also the basename it picks', async () => {
      const g = guard(local('uploads'), 'uploads', STAMPED);
      const src = at('local-src.txt');
      writeFileSync(src, 'L');
      await g.upload(src, 'in/up.txt');
      await g.upload(src);
      expect(store.owner('uploads', 'in/up.txt')).to.equal('user:alice');
      expect(store.owner('uploads', 'local-src.txt')).to.equal('user:alice');
    });

    it('copy onto another filesystem stamps the destination in that filesystem’s store, once', async () => {
      const archive = guard(local('archive'), 'archive', { mode: 'enforce', metadata: 'ArchiveMetadataStore', stampOwner: true });
      const g = guard(local('uploads', { 'a.txt': 'A' }), 'uploads', STAMPED);
      await store.set('uploads', 'a.txt', { owner: bob });
      await g.copy('a.txt', 'kept/a.txt', archive);
      expect(archiveStore.owner('archive', 'kept/a.txt')).to.equal('user:alice');
      expect(archiveStore.calls.filter((c) => c.startsWith('set'))).to.deep.equal(['set archive kept/a.txt']);
      expect(store.owner('uploads', 'a.txt')).to.equal('user:bob');
      expect(store.owner('uploads', 'kept/a.txt')).to.equal(undefined);
    });

    it('zip stamps the archive and unzip the destination directory', async () => {
      const g = guard(local('uploads', { 'docs/a.txt': 'A' }), 'uploads', STAMPED);
      await g.zip(['docs/a.txt'], g, 'out.zip');
      expect(store.owner('uploads', 'out.zip')).to.equal('user:alice');
      principal = bob;
      await g.unzip('out.zip', 'unpacked');
      expect(store.owner('uploads', 'unpacked')).to.equal('user:bob');
    });

    it('writeStream stamps when the stream closes, not when the call returns, and not for a destroyed stream', async () => {
      const g = guard(local('uploads'), 'uploads', STAMPED);
      const stream = (await g.writeStream('s.txt')) as Writable;
      expect(store.owner('uploads', 's.txt')).to.equal(undefined);
      let stampedAtClose: string | undefined;
      stream.once('close', () => (stampedAtClose = store.owner('uploads', 's.txt')));
      stream.end('data');
      await closed(stream);
      expect(stampedAtClose).to.equal('user:alice');

      const aborted = (await g.writeStream('aborted.txt')) as Writable;
      aborted.write('part');
      const done = new Promise((resolve) => aborted.once('close', resolve));
      aborted.destroy();
      await done;
      expect(store.owner('uploads', 'aborted.txt')).to.equal(undefined);
    });

    it('a denied write stamps nothing, and a failing IO touches no metadata', async () => {
      const g = guard(local('uploads', { 'a.txt': 'A' }), 'uploads', STAMPED, new FakeAuthz((p, r) => !(p === 'fs:write' && r === 'file:uploads:no.txt')));
      await g.write('no.txt', 'x').catch(() => undefined);
      await g.copy('missing.txt', 'b.txt').catch(() => undefined);
      expect(store.calls.filter((c) => !c.startsWith('get'))).to.deep.equal([]);
    });
  });

  describe('rm, move and rename', () => {
    it('rm drops the row after the file is gone; a denied rm keeps it', async () => {
      const g = guard(local('uploads', { 'a.txt': 'A', 'keep.txt': 'K' }), 'uploads', STAMPED, new FakeAuthz((p, r) => !(p === 'fs:delete' && r === 'file:uploads:keep.txt')));
      await store.set('uploads', 'a.txt', { owner: alice });
      await store.set('uploads', 'keep.txt', { owner: alice });
      await g.rm('a.txt');
      expect(store.owner('uploads', 'a.txt')).to.equal(undefined);
      expect(await g.rm('keep.txt').catch((e: unknown) => e)).to.be.instanceOf(AccessDenied);
      expect(store.owner('uploads', 'keep.txt')).to.equal('user:alice');
    });

    it('move and rename within a filesystem move the row, the owner unchanged', async () => {
      const g = guard(local('uploads', { 'a.txt': 'A', 'b.txt': 'B' }), 'uploads', STAMPED);
      await store.set('uploads', 'a.txt', { owner: bob });
      await store.set('uploads', 'b.txt', { owner: bob });
      await g.move('a.txt', 'docs/a.txt');
      await g.rename('b.txt', 'c.txt');
      expect(store.owner('uploads', 'docs/a.txt')).to.equal('user:bob');
      expect(store.owner('uploads', 'c.txt')).to.equal('user:bob');
      expect(store.owner('uploads', 'a.txt')).to.equal(undefined);
      expect(store.owner('uploads', 'b.txt')).to.equal(undefined);
    });

    it('move to another filesystem carries the row to its store; to a filesystem without one it is dropped', async () => {
      const archive = guard(local('archive'), 'archive', { mode: 'enforce', metadata: 'ArchiveMetadataStore', stampOwner: true });
      const plain = guard(local('plain'), 'plain', { mode: 'enforce' });
      const g = guard(local('uploads', { 'a.txt': 'A', 'b.txt': 'B' }), 'uploads', STAMPED);
      await store.set('uploads', 'a.txt', { owner: bob, tags: ['x'] });
      await store.set('uploads', 'b.txt', { owner: bob });
      await g.move('a.txt', 'moved/a.txt', archive);
      await g.move('b.txt', 'b.txt', plain);
      expect(await archiveStore.get('archive', 'moved/a.txt')).to.deep.equal({ owner: { type: 'user', id: 'bob' }, tags: ['x'] });
      expect(store.owner('uploads', 'a.txt')).to.equal(undefined);
      expect(store.owner('uploads', 'b.txt')).to.equal(undefined);
      expect(existsSync(join(dir, 'plain', 'b.txt'))).to.equal(true);
    });
  });

  describe('failures', () => {
    it('a metadata failure after the IO is logged at error and rethrown; the IO stays done', async () => {
      const g = guard(local('uploads'), 'uploads', STAMPED);
      store.failing.add('set');
      const e = await g.write('a.txt', 'x').catch((err: unknown) => err);
      expect((e as Error).message).to.equal('set failed');
      expect(existsSync(join(dir, 'uploads', 'a.txt'))).to.equal(true);
      expect(errors.join('\n')).to.contain('a.txt').and.contain('write');
    });

    it('a metadata store the config names but DI does not hold fails before the IO', async () => {
      const g = guard(local('uploads'), 'uploads', { ...STAMPED, metadata: 'NoSuchStore' });
      const e = await g.write('a.txt', 'x').catch((err: unknown) => err);
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect((e as Error).message).to.contain('NoSuchStore');
      expect(existsSync(join(dir, 'uploads', 'a.txt'))).to.equal(false);
    });

    it('a stamp failure of a stream is logged at error and emitted to its error listeners', async () => {
      const g = guard(local('uploads'), 'uploads', STAMPED);
      store.failing.add('set');
      const stream = (await g.writeStream('s.txt')) as Writable;
      const seen: unknown[] = [];
      stream.on('error', (err) => seen.push(err));
      const done = new Promise((resolve) => stream.once('close', resolve));
      stream.end('data');
      await done;
      expect((seen[0] as Error | undefined)?.message).to.equal('set failed');
      expect(errors.join('\n')).to.contain('s.txt');
    });
  });
});
