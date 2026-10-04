import * as chai from 'chai';
import 'mocha';

import { FS_OPERATIONS, FsResourceAdapter, effectiveFsOperations, fsOperationPermissions, parseFsAccessConfig } from '../src/index.js';
import type { FsOperation } from '../src/index.js';

const expect = chai.expect;

const permissionsOf = (op: FsOperation | undefined) => op?.paths.map((p) => ({ arg: p.arg, permissions: [...p.permissions], kind: p.kind, ...(p.onDestination ? { onDestination: true } : {}) }));

describe('authz-fs FS_OPERATIONS', () => {
  it('maps the methods of the study table (design §13) and signed URLs', () => {
    expect(Object.keys(FS_OPERATIONS).sort()).to.deep.equal(['append', 'copy', 'dirExists', 'download', 'exists', 'getSignedUrl', 'hash', 'isDir', 'list', 'metadata', 'mkdir', 'move', 'read', 'readStream', 'rename', 'rm', 'signedUrl', 'stat', 'unzip', 'upload', 'write', 'writeStream', 'zip'].sort());
  });

  for (const method of ['read', 'readStream', 'download', 'hash', 'metadata']) {
    it(`${method}: fs:read on argument 0 as a file`, () => {
      expect(permissionsOf(FS_OPERATIONS[method])).to.deep.equal([{ arg: 0, permissions: ['fs:read'], kind: 'file' }]);
    });
  }

  it('exists and stat: fs:stat on a file; isDir and dirExists: fs:stat on a dir', () => {
    for (const m of ['exists', 'stat']) expect(permissionsOf(FS_OPERATIONS[m]), m).to.deep.equal([{ arg: 0, permissions: ['fs:stat'], kind: 'file' }]);
    for (const m of ['isDir', 'dirExists']) expect(permissionsOf(FS_OPERATIONS[m]), m).to.deep.equal([{ arg: 0, permissions: ['fs:stat'], kind: 'dir' }]);
  });

  it('list: fs:list on a dir; mkdir: fs:write on a dir', () => {
    expect(permissionsOf(FS_OPERATIONS.list)).to.deep.equal([{ arg: 0, permissions: ['fs:list'], kind: 'dir' }]);
    expect(permissionsOf(FS_OPERATIONS.mkdir)).to.deep.equal([{ arg: 0, permissions: ['fs:write'], kind: 'dir' }]);
  });

  it('write, writeStream, append: fs:write; rm: fs:delete', () => {
    for (const m of ['write', 'writeStream', 'append']) expect(permissionsOf(FS_OPERATIONS[m]), m).to.deep.equal([{ arg: 0, permissions: ['fs:write'], kind: 'file' }]);
    expect(permissionsOf(FS_OPERATIONS.rm)).to.deep.equal([{ arg: 0, permissions: ['fs:delete'], kind: 'file' }]);
  });

  it('upload checks only destPath, which defaults to the basename of srcPath', () => {
    expect(permissionsOf(FS_OPERATIONS.upload)).to.deep.equal([{ arg: 1, permissions: ['fs:write'], kind: 'file' }]);
    expect(FS_OPERATIONS.upload.paths[0].default).to.deep.equal({ basenameOf: 0 });
    expect(FS_OPERATIONS.upload.dstFs).to.equal(undefined);
  });

  it('copy and move write on the dstFs argument, defaulting to the called filesystem', () => {
    expect(permissionsOf(FS_OPERATIONS.copy)).to.deep.equal([
      { arg: 0, permissions: ['fs:read'], kind: 'file' },
      { arg: 1, permissions: ['fs:write'], kind: 'file', onDestination: true },
    ]);
    expect(permissionsOf(FS_OPERATIONS.move)).to.deep.equal([
      { arg: 0, permissions: ['fs:read', 'fs:delete'], kind: 'file' },
      { arg: 1, permissions: ['fs:write'], kind: 'file', onDestination: true },
    ]);
    expect(FS_OPERATIONS.copy.dstFs).to.deep.equal({ arg: 2, absent: 'self' });
    expect(FS_OPERATIONS.move.dstFs).to.deep.equal({ arg: 2, absent: 'self' });
  });

  it('rename stays on the called filesystem', () => {
    expect(permissionsOf(FS_OPERATIONS.rename)).to.deep.equal([
      { arg: 0, permissions: ['fs:read', 'fs:delete'], kind: 'file' },
      { arg: 1, permissions: ['fs:write'], kind: 'file' },
    ]);
    expect(FS_OPERATIONS.rename.dstFs).to.equal(undefined);
  });

  it('zip(srcs, dstFs?, dstFile?) and unzip(src, dest?, dstFs?) write on dstFs, the provider default when absent', () => {
    expect(permissionsOf(FS_OPERATIONS.zip)).to.deep.equal([
      { arg: 0, permissions: ['fs:read'], kind: 'file' },
      { arg: 2, permissions: ['fs:write'], kind: 'file', onDestination: true },
    ]);
    expect(FS_OPERATIONS.zip.paths[0].sources).to.equal(true);
    expect(FS_OPERATIONS.zip.paths[1].default).to.deep.equal({ tmpname: '.zip' });
    expect(FS_OPERATIONS.zip.dstFs).to.deep.equal({ arg: 1, absent: 'provider' });

    expect(permissionsOf(FS_OPERATIONS.unzip)).to.deep.equal([
      { arg: 0, permissions: ['fs:read'], kind: 'file' },
      { arg: 1, permissions: ['fs:write'], kind: 'file', onDestination: true },
    ]);
    expect(FS_OPERATIONS.unzip.paths[1].default).to.deep.equal({ tmpname: '' });
    expect(FS_OPERATIONS.unzip.dstFs).to.deep.equal({ arg: 2, absent: 'provider' });
  });

  it('signedUrl and getSignedUrl: fs:share on a file', () => {
    for (const m of ['signedUrl', 'getSignedUrl']) expect(permissionsOf(FS_OPERATIONS[m]), m).to.deep.equal([{ arg: 0, permissions: ['fs:share'], kind: 'file' }]);
  });

  it('is frozen to the leaves and has no prototype', () => {
    expect(Object.getPrototypeOf(FS_OPERATIONS)).to.equal(null);
    expect(Object.isFrozen(FS_OPERATIONS)).to.equal(true);
    for (const [method, op] of Object.entries(FS_OPERATIONS)) {
      expect(Object.isFrozen(op), method).to.equal(true);
      expect(Object.isFrozen(op.paths), method).to.equal(true);
      for (const p of op.paths) {
        expect(Object.isFrozen(p), method).to.equal(true);
        expect(Object.isFrozen(p.permissions), method).to.equal(true);
      }
    }
    expect(FS_OPERATIONS['toString' as string]).to.equal(undefined);
  });
});

describe('authz-fs fsOperationPermissions', () => {
  it('gives method → permission, or the list when a method needs several', () => {
    const view = fsOperationPermissions(FS_OPERATIONS);
    expect(view.read).to.equal('fs:read');
    expect(view.list).to.equal('fs:list');
    expect(view.copy).to.deep.equal(['fs:read', 'fs:write']);
    expect(view.move).to.deep.equal(['fs:read', 'fs:delete', 'fs:write']);
    expect(view.zip).to.deep.equal(['fs:read', 'fs:write']);
    expect(view.signedUrl).to.equal('fs:share');
    expect(Object.keys(view).sort()).to.deep.equal(Object.keys(FS_OPERATIONS).sort());
  });

  it('is what FsResourceAdapter.operations() returns', () => {
    expect(new FsResourceAdapter().operations()).to.deep.equal(fsOperationPermissions(FS_OPERATIONS));
  });
});

describe('authz-fs effectiveFsOperations', () => {
  it('is the table itself without authz.fs.<name>.operations', () => {
    expect(effectiveFsOperations(parseFsAccessConfig('uploads', { mode: 'enforce' }))).to.equal(FS_OPERATIONS);
  });

  it('adds and replaces entries, checked on argument 0 as a file', () => {
    const ops = effectiveFsOperations(parseFsAccessConfig('uploads', { mode: 'enforce', operations: { compact: 'fs:write', read: ['fs:read', 'app:audit'] } }));
    expect(permissionsOf(ops.compact)).to.deep.equal([{ arg: 0, permissions: ['fs:write'], kind: 'file' }]);
    expect(permissionsOf(ops.read)).to.deep.equal([{ arg: 0, permissions: ['fs:read', 'app:audit'], kind: 'file' }]);
    expect(permissionsOf(ops.copy)).to.deep.equal(permissionsOf(FS_OPERATIONS.copy));
    expect(permissionsOf(FS_OPERATIONS.read)).to.deep.equal([{ arg: 0, permissions: ['fs:read'], kind: 'file' }]);
    expect(Object.getPrototypeOf(ops)).to.equal(null);
    expect(Object.isFrozen(ops)).to.equal(true);
  });
});
