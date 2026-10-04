import * as chai from 'chai';
import 'mocha';

import { GLOBAL, ResourceAdapter } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { userPrincipal, runAdapterConformance } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { FS_PERMISSIONS, FsPathResolver, FsResourceAdapter } from '../src/index.js';
import { configuredChild } from './helpers.js';

const expect = chai.expect;

class TaskAttachmentPathResolver extends FsPathResolver {
  readonly fs = 'uploads';
  async parents(_fsName: string, path: string): Promise<readonly ResourceRef[] | null> {
    const m = /^tasks\/([^/]+)/.exec(path);
    return m ? [{ type: 'task', id: m[1] }] : null;
  }
}

describe('authz-fs FsResourceAdapter', () => {
  let child: IContainer | undefined;

  afterEach(async () => {
    await child?.dispose();
    child = undefined;
  });

  it('is registered in the root container as a ResourceAdapter', () => {
    expect(DI.RootContainer.getRegisteredTypes(ResourceAdapter)).to.include(FsResourceAdapter);
  });

  it('declares kind fs, the three types, the fs permissions and no compiles', () => {
    const a = new FsResourceAdapter();
    expect(a.kind).to.equal('fs');
    expect(a.types).to.deep.equal(['fs', 'dir', 'file']);
    expect(a.permissions()).to.equal(FS_PERMISSIONS);
    expect(a.compiles).to.equal(undefined);
  });

  describe('accepts', () => {
    const a = new FsResourceAdapter();

    it('takes plain objects with a string fs and path', () => {
      expect(a.accepts({ fs: 'uploads', path: 'a.txt' })).to.equal(true);
      expect(a.accepts({ fs: 'uploads', path: '' })).to.equal(true);
      expect(a.accepts({ fs: 'uploads', path: 'a', kind: 'dir' })).to.equal(true);
      expect(a.accepts({ fs: 'uploads', path: 'a', kind: 'file' })).to.equal(true);
      expect(a.accepts(Object.assign(Object.create(null), { fs: 'uploads', path: 'a' }))).to.equal(true);
    });

    it('refuses anything else', () => {
      class Target {
        fs = 'uploads';
        path = 'a';
      }
      for (const junk of [null, undefined, 'uploads:a', 1, [], {}, { fs: 'uploads' }, { path: 'a' }, { fs: 1, path: 'a' }, { fs: 'uploads', path: 2 }, { fs: 'uploads', path: 'a', kind: 'link' }, new Target()]) {
        expect(a.accepts(junk), JSON.stringify(junk)).to.equal(false);
      }
    });
  });

  describe('refOf', () => {
    it('gives a file ref by default, a dir ref for kind dir, the fs ref for the root', () => {
      const a = new FsResourceAdapter();
      expect(a.refOf({ fs: 'uploads', path: 'a\\b.txt' })).to.deep.equal({ type: 'file', id: 'uploads:a/b.txt' });
      expect(a.refOf({ fs: 'uploads', path: './docs/', kind: 'dir' })).to.deep.equal({ type: 'dir', id: 'uploads:docs' });
      expect(a.refOf({ fs: 'uploads', path: '/' })).to.deep.equal({ type: 'fs', id: 'uploads' });
    });

    it('reads a rooted path without a base path from the fs root, refuses climbing and drive paths', () => {
      const a = new FsResourceAdapter();
      expect(a.refOf({ fs: 'uploads', path: '/etc/passwd' })).to.deep.equal({ type: 'file', id: 'uploads:etc/passwd' });
      expect(() => a.refOf({ fs: 'uploads', path: '../x' })).to.throw(InvalidArgument);
      expect(() => a.refOf({ fs: 'uploads', path: 'C:\\x' })).to.throw(InvalidArgument);
    });

    it("makes an absolute path relative to the provider's Options.basePath", () => {
      child = DI.child();
      child.register({ Name: 'uploads', Options: { name: 'uploads', basePath: '/data/up' } }).asMapValue('__file_provider_instance__', 'uploads');
      const a = new FsResourceAdapter(child);
      expect(a.refOf({ fs: 'uploads', path: '/data/up/a/b.txt' })).to.deep.equal({ type: 'file', id: 'uploads:a/b.txt' });
      expect(a.refOf({ fs: 'uploads', path: '/data/up' })).to.deep.equal({ type: 'fs', id: 'uploads' });
      expect(a.refOf({ fs: 'uploads', path: '/data/upload/x' })).to.deep.equal({ type: 'file', id: 'uploads:data/upload/x' });
      expect(a.refOf({ fs: 'other', path: '/data/up/x' })).to.deep.equal({ type: 'file', id: 'other:data/up/x' });
    });
  });

  describe('ancestors', () => {
    it('gives null for a foreign or malformed ref', async () => {
      const a = new FsResourceAdapter();
      for (const ref of [{ type: 'task', id: '1' }, GLOBAL, { type: 'file' }, { type: 'file', id: 'uploads:a/../b' }, { type: 'dir', id: 'nocolon' }]) {
        expect(await a.ancestors(ref), JSON.stringify(ref)).to.equal(null);
      }
    });

    it('gives self, parent dirs, fs, GLOBAL and never asks a resolver (D4)', async () => {
      child = await configuredChild({ uploads: { mode: 'enforce', resolver: 'MissingResolver' } });
      child.register(TaskAttachmentPathResolver).as(FsPathResolver);
      const a = new FsResourceAdapter(child);
      expect(await a.ancestors({ type: 'file', id: 'uploads:tasks/42/a.pdf' })).to.deep.equal([
        { type: 'file', id: 'uploads:tasks/42/a.pdf' },
        { type: 'dir', id: 'uploads:tasks/42' },
        { type: 'dir', id: 'uploads:tasks' },
        { type: 'fs', id: 'uploads' },
        GLOBAL,
      ]);
      expect(await a.ancestors({ type: 'fs', id: 'uploads' })).to.deep.equal([{ type: 'fs', id: 'uploads' }, GLOBAL]);
    });
  });
});

describe('authz-fs FsResourceAdapter conformance', () => {
  runAdapterConformance('FsResourceAdapter', () => ({
    adapter: new FsResourceAdapter(),
    targets: [
      { fs: 'uploads', path: 'tasks/42/a.pdf' },
      { fs: 'uploads', path: 'tasks/42', kind: 'dir' },
      { fs: 'uploads', path: 'tasks', kind: 'dir' },
      { fs: 'uploads', path: '' },
      { fs: 'uploads', path: '/rooted/b.txt' },
      { fs: 'fs-temp', path: 'x/y.bin' },
      { fs: '__file_upload_default_provider__', path: 'up.tmp' },
    ],
    principals: [userPrincipal('alice')],
    unknown: [{ type: 'file', id: 'nocolon' }, { type: 'dir', id: 'uploads:a/../b' }, { type: 'fs', id: 'a:b' }, { type: 'file', id: 'uploads:' }],
  }));
});
