import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, GLOBAL, ResourceAdapter } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { userPrincipal, runAdapterConformance } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { FS_PERMISSIONS, FsPathResolver, FsResourceAdapter } from '../src/index.js';
import { configuredChild } from './helpers.js';

const expect = chai.expect;

const task = (id: string): ResourceRef => ({ type: 'task', id });

class TaskAttachmentPathResolver extends FsPathResolver {
  readonly fs = 'uploads';
  async parents(_fsName: string, path: string): Promise<readonly ResourceRef[] | null> {
    const m = /^tasks\/([^/]+)(\/|$)/.exec(path);
    return m ? [task(m[1])] : null;
  }
}

class ProjectResolver extends FsPathResolver {
  readonly fs = /^(uploads|archive-\d+)$/g;
  async parents(fsName: string, _path: string): Promise<readonly ResourceRef[] | null> {
    return [{ type: 'project', id: fsName }];
  }
}

class OtherFsResolver extends FsPathResolver {
  readonly fs = 'invoices';
  async parents(): Promise<readonly ResourceRef[] | null> {
    return [{ type: 'customer', id: 'c1' }];
  }
}

class BrokenResolver extends FsPathResolver {
  readonly fs = 'broken';
  async parents(): Promise<readonly ResourceRef[] | null> {
    return { type: 'task', id: '1' } as unknown as ResourceRef[];
  }
}

const withResolvers = async (fs: unknown, resolvers: (new () => FsPathResolver)[]): Promise<IContainer> => {
  const child = await configuredChild(fs);
  for (const r of resolvers) child.register(r).as(FsPathResolver);
  return child;
};

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

    it('refuses a path above the root and an absolute path without a provider base path', () => {
      const a = new FsResourceAdapter();
      expect(() => a.refOf({ fs: 'uploads', path: '../x' })).to.throw(InvalidArgument);
      expect(() => a.refOf({ fs: 'uploads', path: '/etc/passwd' })).to.throw(InvalidArgument);
    });

    it("makes an absolute path relative to the provider's Options.basePath", () => {
      child = DI.child();
      child.register({ Name: 'uploads', Options: { name: 'uploads', basePath: '/data/up' } }).asMapValue('__file_provider_instance__', 'uploads');
      const a = new FsResourceAdapter(child);
      expect(a.refOf({ fs: 'uploads', path: '/data/up/a/b.txt' })).to.deep.equal({ type: 'file', id: 'uploads:a/b.txt' });
      expect(a.refOf({ fs: 'uploads', path: '/data/up' })).to.deep.equal({ type: 'fs', id: 'uploads' });
      expect(() => a.refOf({ fs: 'uploads', path: '/data/upload/x' })).to.throw(InvalidArgument);
      expect(() => a.refOf({ fs: 'other', path: '/data/up/x' })).to.throw(InvalidArgument);
    });
  });

  describe('ancestors', () => {
    it('gives null for a foreign or malformed ref', async () => {
      child = await withResolvers({}, []);
      const a = new FsResourceAdapter(child);
      for (const ref of [task('1'), GLOBAL, { type: 'file' }, { type: 'file', id: 'uploads:a/../b' }, { type: 'dir', id: 'nocolon' }]) {
        expect(await a.ancestors(ref), JSON.stringify(ref)).to.equal(null);
      }
    });

    it('without a resolver: self, parent dirs, fs, GLOBAL', async () => {
      child = await withResolvers({}, []);
      const a = new FsResourceAdapter(child);
      expect(await a.ancestors({ type: 'file', id: 'uploads:tasks/42/a.pdf' })).to.deep.equal([
        { type: 'file', id: 'uploads:tasks/42/a.pdf' },
        { type: 'dir', id: 'uploads:tasks/42' },
        { type: 'dir', id: 'uploads:tasks' },
        { type: 'fs', id: 'uploads' },
        GLOBAL,
      ]);
    });

    it('takes every registered resolver whose fs matches the name, in registration order', async () => {
      child = await withResolvers({}, [TaskAttachmentPathResolver, OtherFsResolver, ProjectResolver]);
      const a = new FsResourceAdapter(child);
      expect(await a.ancestors({ type: 'file', id: 'uploads:tasks/42/a.pdf' })).to.deep.equal([
        { type: 'file', id: 'uploads:tasks/42/a.pdf' },
        { type: 'dir', id: 'uploads:tasks/42' },
        { type: 'dir', id: 'uploads:tasks' },
        { type: 'fs', id: 'uploads' },
        task('42'),
        { type: 'project', id: 'uploads' },
        GLOBAL,
      ]);
      // A global RegExp keeps lastIndex between test() calls; the match must not depend on it.
      for (let i = 0; i < 3; i++) {
        expect(await a.ancestors({ type: 'fs', id: 'archive-7' })).to.deep.equal([{ type: 'fs', id: 'archive-7' }, { type: 'project', id: 'archive-7' }, GLOBAL]);
      }
      expect(await a.ancestors({ type: 'dir', id: 'invoices:2026' })).to.deep.equal([{ type: 'dir', id: 'invoices:2026' }, { type: 'fs', id: 'invoices' }, { type: 'customer', id: 'c1' }, GLOBAL]);
      expect(await a.ancestors({ type: 'fs', id: 'scratch' })).to.deep.equal([{ type: 'fs', id: 'scratch' }, GLOBAL]);
    });

    it('reads null from a resolver as no parents', async () => {
      child = await withResolvers({}, [TaskAttachmentPathResolver]);
      const a = new FsResourceAdapter(child);
      expect(await a.ancestors({ type: 'file', id: 'uploads:public/a.png' })).to.deep.equal([{ type: 'file', id: 'uploads:public/a.png' }, { type: 'dir', id: 'uploads:public' }, { type: 'fs', id: 'uploads' }, GLOBAL]);
    });

    it('takes only the resolver authz.fs.<name>.resolver names, matched by class name', async () => {
      child = await withResolvers({ uploads: { mode: 'enforce', resolver: 'TaskAttachmentPathResolver' }, invoices: { mode: 'audit', resolver: 'ProjectResolver' } }, [ProjectResolver, TaskAttachmentPathResolver, OtherFsResolver]);
      const a = new FsResourceAdapter(child);
      expect(await a.ancestors({ type: 'dir', id: 'uploads:tasks/7' })).to.deep.equal([{ type: 'dir', id: 'uploads:tasks/7' }, { type: 'dir', id: 'uploads:tasks' }, { type: 'fs', id: 'uploads' }, task('7'), GLOBAL]);
      expect(await a.ancestors({ type: 'fs', id: 'invoices' })).to.deep.equal([{ type: 'fs', id: 'invoices' }, { type: 'project', id: 'invoices' }, GLOBAL]);
    });

    it('refuses a resolver name no registered FsPathResolver has', async () => {
      child = await withResolvers({ uploads: { mode: 'enforce', resolver: 'MissingResolver' } }, [TaskAttachmentPathResolver]);
      const a = new FsResourceAdapter(child);
      let error: unknown;
      await a.ancestors({ type: 'fs', id: 'uploads' }).catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.include('authz.fs.uploads.resolver').and.include('MissingResolver');
    });

    it('refuses a resolver answer that is not a list of refs', async () => {
      child = await withResolvers({}, [BrokenResolver]);
      const a = new FsResourceAdapter(child);
      let error: unknown;
      await a.ancestors({ type: 'fs', id: 'broken' }).catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.include('BrokenResolver');
    });
  });
});

describe('authz-fs FsResourceAdapter conformance', () => {
  runAdapterConformance('FsResourceAdapter', async () => {
    const child = await withResolvers({ uploads: { mode: 'enforce', resolver: 'ProjectResolver' } }, [ProjectResolver, TaskAttachmentPathResolver]);
    return {
      adapter: new FsResourceAdapter(child),
      targets: [
        { fs: 'uploads', path: 'tasks/42/a.pdf' },
        { fs: 'uploads', path: 'tasks/42', kind: 'dir' },
        { fs: 'uploads', path: 'tasks', kind: 'dir' },
        { fs: 'uploads', path: '' },
        { fs: 'fs-temp', path: 'x/y.bin' },
        { fs: '__file_upload_default_provider__', path: 'up.tmp' },
      ],
      principals: [userPrincipal('alice')],
      unknown: [{ type: 'file', id: 'nocolon' }, { type: 'dir', id: 'uploads:a/../b' }, { type: 'fs', id: 'a:b' }, { type: 'file', id: 'uploads:' }],
      dispose: () => child.dispose(),
    };
  });
});
