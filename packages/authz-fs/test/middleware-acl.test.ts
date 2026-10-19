import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { AccessDenied, SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import { ResourceDuplicated } from '@spinajs/exceptions';
import { fsNative } from '@spinajs/fs';
import type { IFsLocalOptions, fs } from '@spinajs/fs';

import { ALICE, BOB } from './support/acl-contract.js';
import { useMiddleware } from './support/mw-setup.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const CAROL = { type: 'user', id: 'carol' };

const ENTRIES = {
  'mw-own': { mode: 'enforce', stampOwner: true },
  'mw-own2': { mode: 'enforce', stampOwner: true },
  'mw-audit': { mode: 'audit', stampOwner: true },
  'mw-up': { mode: 'enforce' },
  'mw-off': { mode: 'off' },
};

const closed = (stream: Writable): Promise<void> => new Promise((resolve, reject) => stream.once('close', resolve).once('error', reject));

/**
 * A local provider that answers as fsS3 does: a key is never a directory, every prefix is one for dirExists, a list
 * holds only the keys directly under the prefix, and a key may share its name with a prefix (such a key is kept in
 * `shadowKeys`, as the disk holds the directory there).
 */
class KeyStoreFs extends fsNative<IFsLocalOptions> {
  readonly shadowKeys = new Set<string>();

  protected async doIsDir(): Promise<boolean> {
    return false;
  }

  protected async doDirExists(): Promise<boolean> {
    return true;
  }

  protected async doExists(path: string): Promise<boolean> {
    return this.shadowKeys.has(path) || (!this.onDiskDir(path) && (await super.doExists(path)));
  }

  protected async doWrite(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    if (this.onDiskDir(path)) this.shadowKeys.add(path);
    else await super.doWrite(path, data, encoding);
  }

  protected async doList(path: string): Promise<string[]> {
    if (!this.onDiskDir(path)) return [];
    return readdirSync(this.resolvePath(path), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => (path ? `${path}/${e.name}` : e.name));
  }

  /** Throws when set, as a failed ListObjectsV2 would. */
  entriesFailure?: Error;

  protected async doHasEntries(path: string): Promise<boolean> {
    if (this.entriesFailure) throw this.entriesFailure;
    const nested = this.onDiskDir(path) && readdirSync(this.resolvePath(path), { recursive: true, withFileTypes: true }).some((e) => e.isFile());
    return nested || [...this.shadowKeys].some((k) => path === '' || k.startsWith(`${path}/`));
  }

  /** Deletes the key only: the keys under its prefix stay, as DeleteObject leaves them. */
  protected async doRm(path: string): Promise<void> {
    if (this.onDiskDir(path)) this.shadowKeys.delete(path);
    else await super.doRm(path);
  }

  protected async doMove(oldPath: string, newPath: string, dstFs?: fs): Promise<void> {
    if (this.shadowKeys.has(oldPath)) return this.moveShadowKey(oldPath, newPath);
    if (!this.onDiskDir(newPath)) return super.doMove(oldPath, newPath, dstFs);
    await super.doRm(oldPath);
    this.shadowKeys.add(newPath);
  }

  protected async doRename(oldPath: string, newPath: string): Promise<void> {
    if (this.shadowKeys.has(oldPath)) return this.moveShadowKey(oldPath, newPath);
    if (!this.onDiskDir(newPath)) return super.doRename(oldPath, newPath);
    await super.doRm(oldPath);
    this.shadowKeys.add(newPath);
  }

  private async moveShadowKey(oldPath: string, newPath: string): Promise<void> {
    this.shadowKeys.delete(oldPath);
    await this.doWrite(newPath, 'key');
  }

  private onDiskDir(path: string): boolean {
    return statSync(this.resolvePath(path), { throwIfNoEntry: false })?.isDirectory() === true;
  }
}

describe('authz-fs AuthzFsMiddleware: owner stamping', function () {
  this.timeout(20000);
  const s = useMiddleware(ENTRIES);

  it('a file the principal creates gets its owner row; a path that existed gets none', async () => {
    const own = s.local('mw-own', { 'old.txt': 'O' });
    await own.write('mine.txt', 'x');
    await own.write('old.txt', 'y');
    expect(s.acl.owner('mw-own', 'mine.txt')).to.equal('user:alice');
    expect(s.acl.owner('mw-own', 'old.txt')).to.equal(undefined);
  });

  it('stamps the principal the decision ran for (the inherit delegate)', async () => {
    s.authz.speaker = () => ({ type: 'user', id: 'delegate' });
    await s.local('mw-own').write('d.txt', 'x');
    expect(s.acl.owner('mw-own', 'd.txt')).to.equal('user:delegate');
  });

  it('SYSTEM, UNATTENDED, anonymous and link principals own nothing', async () => {
    const own = s.local('mw-own');
    const principals = [SYSTEM, UNATTENDED, { ...userPrincipal('a1'), type: 'anonymous' }, { ...userPrincipal('l1'), type: 'link' }] as Principal[];
    for (const [i, p] of principals.entries()) {
      s.principal = p;
      await own.write(`p${i}.txt`, 'x');
    }
    expect(s.acl.rows).to.deep.equal([]);
  });

  it('without stampOwner nothing is stamped', async () => {
    await s.local('mw-up').write('n.txt', 'x');
    expect(s.acl.rows).to.deep.equal([]);
  });

  it('an overwrite and an append keep the first owner; an append that creates the file stamps it', async () => {
    const own = s.local('mw-own');
    await own.write('a.txt', 'x');
    s.principal = userPrincipal('bob');
    await own.write('a.txt', 'y');
    await own.append('a.txt', 'z');
    await own.append('b.txt', 'z');
    expect(s.acl.owner('mw-own', 'a.txt')).to.equal('user:alice');
    expect(s.acl.owner('mw-own', 'b.txt')).to.equal('user:bob');
  });

  it('mkdir stamps a directory it creates, not an existing one', async () => {
    const own = s.local('mw-own', { 'docs/a.txt': 'A' });
    await own.mkdir('docs');
    await own.mkdir('fresh');
    expect(s.acl.owner('mw-own', 'docs')).to.equal(undefined);
    expect(s.acl.owner('mw-own', 'fresh')).to.equal('user:alice');
  });

  it('upload, copy, zip and unzip stamp only the destination they create; ACL rows are not copied', async () => {
    const own = s.local('mw-own', { 'docs/a.txt': 'A' });
    const other = s.local('mw-own2');
    await s.acl.grant({ fs: 'mw-own', path: 'docs/a.txt', subject: CAROL, relation: 'viewer' });
    const localFile = join(s.dir, 'local.txt');
    writeFileSync(localFile, 'L');
    await own.upload(localFile, 'up.txt');
    await own.copy('docs/a.txt', 'copy.txt', other);
    await own.zip(['docs/a.txt'], own, 'a.zip');
    await own.unzip('a.zip', 'unz', own);
    expect(['up.txt', 'a.zip', 'unz'].map((p) => s.acl.owner('mw-own', p))).to.deep.equal(['user:alice', 'user:alice', 'user:alice']);
    expect(s.acl.owner('mw-own2', 'copy.txt')).to.equal('user:alice');
    expect(s.acl.rows.filter((r) => r.relation === 'viewer').map((r) => `${r.fs}:${r.path}`)).to.deep.equal(['mw-own:docs/a.txt']);
  });

  it('upload passes its options through: exclusive onto an existing file is ResourceDuplicated and the rows stay', async () => {
    const own = s.local('mw-own', { 'old.txt': 'O' });
    await s.acl.grant({ fs: 'mw-own', path: 'old.txt', subject: BOB, relation: 'owner' });
    const localFile = join(s.dir, 'local.txt');
    writeFileSync(localFile, 'L');
    await expect(own.upload(localFile, 'old.txt', { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
    expect(s.acl.owner('mw-own', 'old.txt')).to.equal('user:bob');
    await own.upload(localFile, 'new.txt', { exclusive: true });
    expect(s.acl.owner('mw-own', 'new.txt')).to.equal('user:alice');
  });

  it("a zip archive's unlink() is an rm checked as fs:delete; it drops the archive's rows, and an fs in mode 'off' is not checked", async () => {
    const own = s.local('mw-own', { 'docs/a.txt': 'A' });
    const zipped = await own.zip(['docs/a.txt'], own, 'a.zip');
    expect(s.acl.owner('mw-own', 'a.zip')).to.equal('user:alice');
    s.authz.calls.length = 0;
    await zipped.unlink();
    expect(s.authz.keys()).to.deep.equal(['fs:delete file:mw-own:a.zip']);
    expect(s.acl.owner('mw-own', 'a.zip')).to.equal(undefined);

    const off = s.local('mw-off');
    const elsewhere = await own.zip(['docs/a.txt'], off, 'b.zip');
    s.authz.calls.length = 0;
    s.authz.allow = () => false;
    await elsewhere.unlink();
    expect(s.authz.calls).to.deep.equal([]);
    expect(existsSync(join(s.dir, 'mw-off', 'b.zip'))).to.equal(false);
  });

  it('a write the policy denied in audit mode, or allowed only conditionally, stamps nothing', async () => {
    const audit = s.local('mw-audit');
    s.authz.allow = () => false;
    await audit.write('denied.txt', 'x');
    s.authz.allow = () => 'conditional';
    await audit.write('cond.txt', 'x');
    expect(s.acl.rows).to.deep.equal([]);
  });

  it('writeStream stamps once the stream finished; a destroyed stream stamps nothing', async () => {
    const own = s.local('mw-own');
    const stream = (await own.writeStream('s.txt')) as Writable;
    expect(s.acl.owner('mw-own', 's.txt')).to.equal(undefined);
    const done = closed(stream);
    stream.end('x');
    await done;
    expect(s.acl.owner('mw-own', 's.txt')).to.equal('user:alice');

    const broken = (await own.writeStream('broken.txt')) as Writable;
    const gone = new Promise((resolve) => broken.once('close', resolve));
    broken.destroy();
    await gone;
    expect(s.acl.owner('mw-own', 'broken.txt')).to.equal(undefined);
  });

  it('a new path never inherits stale rows left at it or under it', async () => {
    const own = s.local('mw-own');
    for (const path of ['gone.txt', 'gonedir', 'gonedir/x.txt']) await s.acl.grant({ fs: 'mw-own', path, subject: { type: 'user', id: 'mallory' }, relation: 'owner' });
    await own.write('gone.txt', 'x');
    await own.mkdir('gonedir');
    expect(s.acl.rows.map((r) => `${r.path} ${r.subjectKey}`).sort()).to.deep.equal(['gone.txt user:alice', 'gonedir user:alice']);
  });

  it('a failing hasEntries probe refuses the write: nothing is cleared, stamped or written', async () => {
    const keys = new KeyStoreFs({ name: 'mw-own', basePath: s.base('mw-own') });
    await s.acl.grant({ fs: 'mw-own', path: 'new.txt', subject: BOB, relation: 'owner' });
    keys.entriesFailure = new Error('throttled');
    await expect(keys.write('new.txt', 'x')).to.be.rejectedWith('throttled');
    expect(s.acl.rows.map((r) => `${r.path} ${r.subjectKey} ${r.relation}`)).to.deep.equal(['new.txt user:bob owner']);
    expect(existsSync(join(s.dir, 'mw-own', 'new.txt'))).to.equal(false);
  });

  it('a key written where keys sit under its prefix leaves the folder rows alone and claims nothing, with and without stampOwner', async () => {
    for (const name of ['mw-own', 'mw-up']) {
      const keys = new KeyStoreFs({ name, basePath: s.base(name, { 'd/a.txt': 'A' }) });
      await s.acl.grant({ fs: name, path: 'd', subject: BOB, relation: 'owner' });
      await s.acl.grant({ fs: name, path: 'd', subject: CAROL, relation: 'viewer' });
      s.authz.allow = (permission, resource) => permission === 'fs:write' && resource === `file:${name}:d`;
      await keys.write('d', 'key');
      expect(keys.shadowKeys.has('d'), name).to.equal(true);
      expect(s.acl.rows.filter((r) => r.fs === name).map((r) => `${r.path} ${r.subjectKey} ${r.relation}`).sort(), name).to.deep.equal(['d user:bob owner', 'd user:carol viewer']);
    }
  });

  it('a key written where only nested keys sit under its prefix leaves the folder rows alone and claims nothing, with and without stampOwner', async () => {
    for (const name of ['mw-own', 'mw-up']) {
      const keys = new KeyStoreFs({ name, basePath: s.base(name, { 'd/sub/a.txt': 'A' }) });
      await s.acl.grant({ fs: name, path: 'd', subject: BOB, relation: 'owner' });
      s.authz.allow = (permission, resource) => permission === 'fs:write' && resource === `file:${name}:d`;
      await keys.write('d', 'key');
      expect(keys.shadowKeys.has('d'), name).to.equal(true);
      expect(s.acl.rows.filter((r) => r.fs === name).map((r) => `${r.path} ${r.subjectKey} ${r.relation}`), name).to.deep.equal(['d user:bob owner']);
    }
  });

  it('a fresh key with nothing under it is stamped on a key store', async () => {
    const keys = new KeyStoreFs({ name: 'mw-own', basePath: s.base('mw-own', { 'd/a.txt': 'A' }) });
    await keys.write('fresh.txt', 'x');
    expect(s.acl.owner('mw-own', 'fresh.txt')).to.equal('user:alice');
  });

  it('mkdir onto an existing file leaves its owner row in place', async () => {
    const own = s.local('mw-own', { 'f.txt': 'F' });
    await s.acl.grant({ fs: 'mw-own', path: 'f.txt', subject: BOB, relation: 'owner' });
    await expect(own.mkdir('f.txt')).to.be.rejected;
    expect(s.acl.owner('mw-own', 'f.txt')).to.equal('user:bob');
  });
});

describe('authz-fs AuthzFsMiddleware: rm, move and rename', function () {
  this.timeout(20000);
  const s = useMiddleware(ENTRIES);

  const grant = (fs: string, path: string, subject = ALICE, relation = 'viewer') => s.acl.grant({ fs, path, subject, relation });

  it('rm of a directory drops the rows at the path and under it, not siblings by prefix; a denied rm keeps them', async () => {
    const own = s.local('mw-own', { 'd/a.txt': 'A', 'd/sub/b.txt': 'B', 'd-x.txt': 'X' });
    for (const path of ['d', 'd/a.txt', 'd/sub/b.txt', 'd-x.txt']) await grant('mw-own', path);
    s.authz.allow = (permission) => permission !== 'fs:delete';
    await expect(own.rm('d')).to.be.rejectedWith(AccessDenied);
    expect(s.acl.rows).to.have.length(4);
    s.authz.allow = () => true;
    await own.rm('d');
    expect(s.acl.rows.map((r) => r.path)).to.deep.equal(['d-x.txt']);
  });

  it('rm of a file drops only the rows at its path', async () => {
    const own = s.local('mw-own', { 'f.txt': 'F' });
    for (const path of ['f.txt', 'f.txt/stale']) await grant('mw-own', path);
    await own.rm('f.txt');
    expect(s.acl.rows.map((r) => r.path)).to.deep.equal(['f.txt/stale']);
  });

  it('on a key store (isDir never true) rm, move and rename of a key whose prefix holds keys keep the rows the prefix shares', async () => {
    const keys = new KeyStoreFs({ name: 'mw-own', basePath: s.base('mw-own', { 'd/a.txt': 'A', 'k/b.txt': 'B', 'r/sub/c.txt': 'C' }) });
    for (const key of ['d', 'k', 'r']) keys.shadowKeys.add(key);
    for (const path of ['d', 'd/a.txt', 'k', 'k/b.txt', 'r', 'r/sub/c.txt']) await grant('mw-own', path, BOB, 'owner');
    await keys.rm('d');
    await keys.move('k', 'm');
    await keys.rename('r', 'n');
    expect([...keys.shadowKeys]).to.deep.equal([]);
    expect(existsSync(join(s.dir, 'mw-own', 'm'))).to.equal(true);
    expect(s.acl.rows.map((r) => `${r.path} ${r.subjectKey}`).sort()).to.deep.equal(['d user:bob', 'd/a.txt user:bob', 'k user:bob', 'k/b.txt user:bob', 'r user:bob', 'r/sub/c.txt user:bob']);
  });

  it('on a key store rm, move and rename of a key with nothing under its prefix take its own rows', async () => {
    const keys = new KeyStoreFs({ name: 'mw-own', basePath: s.base('mw-own', { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'b.txt.d/x.txt': 'X' }) });
    for (const path of ['a.txt', 'b.txt', 'c.txt', 'b.txt.d/x.txt']) await grant('mw-own', path, BOB, 'owner');
    await keys.rm('a.txt');
    await keys.move('b.txt', 'b2.txt');
    await keys.rename('c.txt', 'c2.txt');
    expect(s.acl.rows.map((r) => r.path).sort()).to.deep.equal(['b.txt.d/x.txt', 'b2.txt', 'c2.txt']);
  });

  it('a key moved or renamed onto a prefix holding only nested keys does not carry its rows there', async () => {
    const keys = new KeyStoreFs({ name: 'mw-own', basePath: s.base('mw-own', { 'd/sub/a.txt': 'A', 'm.txt': 'M', 'r.txt': 'R' }) });
    await grant('mw-own', 'd', BOB, 'owner');
    await grant('mw-own', 'm.txt', CAROL, 'owner');
    await grant('mw-own', 'r.txt', CAROL, 'viewer');
    await keys.move('m.txt', 'd');
    await keys.rename('r.txt', 'd');
    expect(s.acl.rows.map((r) => `${r.path} ${r.subjectKey} ${r.relation}`)).to.deep.equal(['d user:bob owner']);
  });

  it('a key moved onto a prefix that holds keys does not carry its rows there; its own rows go', async () => {
    const keys = new KeyStoreFs({ name: 'mw-own', basePath: s.base('mw-own', { 'd/a.txt': 'A', 'src.txt': 'S' }) });
    await grant('mw-own', 'd', BOB, 'owner');
    await grant('mw-own', 'src.txt', CAROL, 'owner');
    await keys.move('src.txt', 'd');
    expect(keys.shadowKeys.has('d')).to.equal(true);
    expect(s.acl.rows.map((r) => `${r.path} ${r.subjectKey} ${r.relation}`)).to.deep.equal(['d user:bob owner']);
  });

  it('SYSTEM is not checked but keeps the ACL in step', async () => {
    const own = s.local('mw-own', { 'a.txt': 'A' });
    await grant('mw-own', 'a.txt', ALICE, 'owner');
    s.principal = SYSTEM;
    s.authz.allow = () => false;
    await own.rm('a.txt');
    expect(s.acl.rows).to.deep.equal([]);
    expect(s.authz.calls).to.deep.equal([]);
  });

  it('move and rename carry the rows to a new path, also onto another filesystem, and stamp no owner', async () => {
    const own = s.local('mw-own', { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' });
    const other = s.local('mw-own2');
    for (const path of ['a.txt', 'b.txt', 'c.txt']) await grant('mw-own', path, CAROL);
    await own.move('a.txt', 'docs/a2.txt');
    await own.rename('b.txt', 'b2.txt');
    await own.move('c.txt', 'c2.txt', other);
    expect(s.acl.rows.map((r) => `${r.fs}:${r.path} ${r.subjectKey}`).sort()).to.deep.equal(['mw-own2:c2.txt user:carol', 'mw-own:b2.txt user:carol', 'mw-own:docs/a2.txt user:carol']);
  });

  it('a directory moved within a filesystem takes the rows under it along', async () => {
    const own = s.local('mw-own', { 'd/a.txt': 'A', 'd/sub/b.txt': 'B' });
    for (const path of ['d', 'd/a.txt', 'd/sub/b.txt']) await grant('mw-own', path);
    await own.move('d', 'e');
    expect(s.acl.rows.map((r) => r.path).sort()).to.deep.equal(['e', 'e/a.txt', 'e/sub/b.txt']);
  });

  it('a path longer than the ACL holds, created outside the middleware, is removed, moved and renamed without a row update', async () => {
    const long = `${'d'.repeat(200)}/${'e'.repeat(200)}/${'f'.repeat(120)}`;
    const own = s.local('mw-own', { [`${long}/a.txt`]: 'A', [`${long}/b.txt`]: 'B', [`${long}/c.txt`]: 'C' });
    await grant('mw-own', 'd'.repeat(200), BOB, 'owner');
    await own.rm(`${long}/a.txt`);
    await own.move(`${long}/b.txt`, 'b.txt');
    await own.rename(`${long}/c.txt`, 'c.txt');
    expect(existsSync(join(s.dir, 'mw-own', 'b.txt')) && existsSync(join(s.dir, 'mw-own', 'c.txt'))).to.equal(true);
    expect(s.errors).to.deep.equal([]);
    expect(s.acl.rows.map((r) => `${r.path} ${r.subjectKey}`)).to.deep.equal([`${'d'.repeat(200)} user:bob`]);
  });

  it('a move onto a path longer than the ACL holds drops the source rows; a directory move drops the rows that would not fit', async () => {
    const long = `${'d'.repeat(200)}/${'e'.repeat(200)}/${'f'.repeat(120)}`;
    const own = s.local('mw-own', { 'a.txt': 'A', 'm/a.txt': 'M' });
    const off = s.local('mw-off');
    const deep = `m/${'x'.repeat(505)}`;
    for (const path of ['a.txt', 'm', 'm/a.txt', deep]) await grant('mw-own', path, BOB, 'owner');
    await own.move('a.txt', long, off);
    await own.move('m', 'longer-name');
    expect(s.errors).to.deep.equal([]);
    expect(s.acl.rows.map((r) => `${r.fs}:${r.path}`).sort()).to.deep.equal(['mw-own:longer-name', 'mw-own:longer-name/a.txt']);
  });

  it('a rename onto an existing file keeps its rows; the source rows go', async () => {
    const own = s.local('mw-own', { 'a.txt': 'A', 'b.txt': 'B' });
    await grant('mw-own', 'a.txt', ALICE, 'owner');
    await grant('mw-own', 'b.txt', BOB, 'owner');
    await own.rename('b.txt', 'a.txt');
    expect(s.acl.rows.map((r) => `${r.path} ${r.subjectKey}`)).to.deep.equal(['a.txt user:alice']);
  });
});

describe('authz-fs AuthzFsMiddleware: ACL failures', function () {
  this.timeout(20000);
  const s = useMiddleware(ENTRIES);

  it('a row update failing after the IO is logged at error and rethrown; the IO stays done', async () => {
    const own = s.local('mw-own');
    s.acl.failing.add('setOwnerIfAbsent');
    await expect(own.write('f.txt', 'x')).to.be.rejectedWith('setOwnerIfAbsent failed');
    expect(existsSync(join(s.dir, 'mw-own', 'f.txt'))).to.equal(true);
    expect(s.errors).to.have.length(1);
    expect(s.errors[0]).to.contain('write on mw-own:f.txt succeeded, but the file ACL was not updated');
  });

  it('a store failing before the IO stops the write', async () => {
    s.acl.failing.add('deleteTree');
    await expect(s.local('mw-own').write('g.txt', 'x')).to.be.rejectedWith('deleteTree failed');
    expect(existsSync(join(s.dir, 'mw-own', 'g.txt'))).to.equal(false);
  });

  it("a failing stamp of a stream reaches the stream's error listeners, then close", async () => {
    const own = s.local('mw-own');
    s.acl.failing.add('setOwnerIfAbsent');
    const stream = (await own.writeStream('s.txt')) as Writable;
    const seen: unknown[] = [];
    stream.on('error', (e) => seen.push(e));
    const done = new Promise((resolve) => stream.once('close', resolve));
    stream.end('x');
    await done;
    expect(String(seen[0])).to.contain('setOwnerIfAbsent failed');
    expect(s.errors).to.have.length(1);
  });
});
