import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';

import { FsPathResolver, resolveFsParents } from '../src/index.js';
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

class EchoResolver extends FsPathResolver {
  readonly fs = 'uploads';
  async parents(_fsName: string, path: string): Promise<readonly ResourceRef[] | null> {
    const m = /^tasks\/([^/]+)/.exec(path);
    return m ? [task(m[1]), task(m[1])] : [];
  }
}

class BrokenResolver extends FsPathResolver {
  readonly fs = 'broken';
  async parents(): Promise<readonly ResourceRef[] | null> {
    return { type: 'task', id: '1' } as unknown as ResourceRef[];
  }
}

class TypeLevelResolver extends FsPathResolver {
  readonly fs = 'typeless';
  async parents(): Promise<readonly ResourceRef[] | null> {
    return [{ type: 'task' }];
  }
}

const withResolvers = async (fs: unknown, resolvers: (new () => FsPathResolver)[]): Promise<IContainer> => {
  const child = await configuredChild(fs);
  for (const r of resolvers) child.register(r).as(FsPathResolver);
  return child;
};

const failure = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
};

describe('authz-fs resolveFsParents', () => {
  let child: IContainer | undefined;

  afterEach(async () => {
    await child?.dispose();
    child = undefined;
  });

  it('gives no parents without a resolver', async () => {
    child = await withResolvers({}, []);
    expect(await resolveFsParents('uploads', 'tasks/42/a.pdf', child)).to.deep.equal([]);
  });

  it('takes every registered resolver whose fs matches the name, in registration order', async () => {
    child = await withResolvers({}, [TaskAttachmentPathResolver, OtherFsResolver, ProjectResolver]);
    expect(await resolveFsParents('uploads', 'tasks/42/a.pdf', child)).to.deep.equal([task('42'), { type: 'project', id: 'uploads' }]);
    // A global RegExp keeps lastIndex between test() calls; the match must not depend on it.
    for (let i = 0; i < 3; i++) expect(await resolveFsParents('archive-7', '', child)).to.deep.equal([{ type: 'project', id: 'archive-7' }]);
    expect(await resolveFsParents('invoices', '2026', child)).to.deep.equal([{ type: 'customer', id: 'c1' }]);
    expect(await resolveFsParents('scratch', 'x', child)).to.deep.equal([]);
  });

  it('reads null from a resolver as no parents', async () => {
    child = await withResolvers({}, [TaskAttachmentPathResolver]);
    expect(await resolveFsParents('uploads', 'public/a.png', child)).to.deep.equal([]);
  });

  it('drops repeated parents', async () => {
    child = await withResolvers({}, [TaskAttachmentPathResolver, EchoResolver]);
    expect(await resolveFsParents('uploads', 'tasks/9/a', child)).to.deep.equal([task('9')]);
  });

  it('takes only the resolver authz.fs.<name>.resolver names, matched by class name', async () => {
    child = await withResolvers({ uploads: { mode: 'enforce', resolver: 'TaskAttachmentPathResolver' }, invoices: { mode: 'audit', resolver: 'ProjectResolver' } }, [ProjectResolver, TaskAttachmentPathResolver, OtherFsResolver]);
    expect(await resolveFsParents('uploads', 'tasks/7', child)).to.deep.equal([task('7')]);
    expect(await resolveFsParents('invoices', '', child)).to.deep.equal([{ type: 'project', id: 'invoices' }]);
  });

  it('refuses a resolver name no registered FsPathResolver has', async () => {
    child = await withResolvers({ uploads: { mode: 'enforce', resolver: 'MissingResolver' } }, [TaskAttachmentPathResolver]);
    const error = await failure(resolveFsParents('uploads', 'a', child));
    expect(error).to.be.instanceOf(AuthzConfigError);
    expect(error.message).to.include('authz.fs.uploads.resolver').and.include('MissingResolver');
  });

  it('refuses a resolver answer that is not a list of instance refs', async () => {
    child = await withResolvers({}, [BrokenResolver, TypeLevelResolver]);
    for (const [fsName, name] of [
      ['broken', 'BrokenResolver'],
      ['typeless', 'TypeLevelResolver'],
    ]) {
      const error = await failure(resolveFsParents(fsName, 'a', child));
      expect(error, fsName).to.be.instanceOf(AuthzConfigError);
      expect(error.message, fsName).to.include(name);
    }
  });
});
