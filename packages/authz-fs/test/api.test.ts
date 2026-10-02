import * as chai from 'chai';
import 'mocha';

import { FileMetadataStore, FsDecorator, FsPathResolver, fromFsPath } from '../src/index.js';
import * as root from '../src/index.js';
import type { FileMeta } from '../src/index.js';
import type { PrincipalRef, ResourceRef } from '@spinajs/authz';
import type { IProviderConfiguration, fs } from '@spinajs/fs';

const expect = chai.expect;

class PassThrough extends FsDecorator {
  readonly order = 100;
  decorate(instance: fs, _config: IProviderConfiguration): fs {
    return instance;
  }
}

class MemoryStore extends FileMetadataStore {
  readonly rows = new Map<string, FileMeta>();
  async get(fsName: string, path: string): Promise<FileMeta | null> {
    return this.rows.get(`${fsName}:${path}`) ?? null;
  }
  async set(fsName: string, path: string, meta: FileMeta): Promise<void> {
    this.rows.set(`${fsName}:${path}`, meta);
  }
  async move(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    const meta = this.rows.get(`${fromFs}:${from}`);
    this.rows.delete(`${fromFs}:${from}`);
    if (meta) this.rows.set(`${toFs}:${to}`, meta);
  }
  async delete(fsName: string, path: string): Promise<void> {
    this.rows.delete(`${fsName}:${path}`);
  }
}

class TaskResolver extends FsPathResolver {
  readonly fs = /^uploads$/;
  async parents(_fsName: string, path: string): Promise<readonly ResourceRef[] | null> {
    return path.startsWith('tasks/') ? [{ type: 'task', id: path.split('/')[1] }] : null;
  }
}

describe('authz-fs api', () => {
  it('fromFsPath throws not implemented', () => {
    expect(() => fromFsPath('uploads', 'path')).to.throw(Error, /^@spinajs\/authz-fs: fromFsPath is not implemented yet$/);
  });

  it('abstract classes are runtime exports and take minimal fakes', async () => {
    for (const k of ['FsDecorator', 'FileMetadataStore', 'FsPathResolver']) {
      expect((root as any)[k], k).to.be.a('function');
    }
    const raw = {} as fs;
    expect(new PassThrough().decorate(raw, {} as IProviderConfiguration)).to.equal(raw);
    const store = new MemoryStore();
    const owner: PrincipalRef = { type: 'user', id: 'u1' };
    await store.set('uploads', 'a.txt', { owner, tags: ['x'] });
    await store.move('uploads', 'a.txt', 'archive', 'b.txt');
    expect(await store.get('uploads', 'a.txt')).to.equal(null);
    expect((await store.get('archive', 'b.txt'))?.owner).to.equal(owner);
    await store.delete('archive', 'b.txt');
    expect(await store.get('archive', 'b.txt')).to.equal(null);
    expect(await new TaskResolver().parents('uploads', 'tasks/7/x.png')).to.deep.equal([{ type: 'task', id: '7' }]);
  });

  it('FileMeta members are optional and readonly', () => {
    const empty: FileMeta = {};
    const full: FileMeta = { owner: { type: 'user', id: 'u1' }, scope: { type: 'project', id: 'p1' }, tags: [] };
    // @ts-expect-error FileMeta is readonly
    full.tags = ['x'];
    expect([empty, full]).to.have.length(2);
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Shape<C> = Pick<C, keyof C>;
const yes = <_T extends true>(): void => {};

// authz-http's ResourceExtractor with the request widened, so this test needs no authz-http.
type LooseExtractor = (req: any) => ResourceRef | object | Promise<ResourceRef | object>;

describe('authz-fs pinned shapes', () => {
  it('match the design exactly', () => {
    yes<Equal<Shape<FsDecorator>, { readonly order: number; decorate(instance: fs, config: IProviderConfiguration): fs }>>();
    yes<Equal<FileMeta, { readonly owner?: PrincipalRef; readonly scope?: ResourceRef; readonly tags?: readonly string[] }>>();
    yes<
      Equal<
        Shape<FileMetadataStore>,
        {
          get(fsName: string, path: string): Promise<FileMeta | null>;
          set(fsName: string, path: string, meta: FileMeta): Promise<void>;
          move(fromFs: string, from: string, toFs: string, to: string): Promise<void>;
          delete(fsName: string, path: string): Promise<void>;
        }
      >
    >();
    yes<Equal<Shape<FsPathResolver>, { readonly fs: string | RegExp; parents(fsName: string, path: string): Promise<readonly ResourceRef[] | null> }>>();
    yes<Equal<typeof fromFsPath, (fsName: string, param: string) => (req: unknown) => ResourceRef | Promise<ResourceRef>>>();
    yes<ReturnType<typeof fromFsPath> extends LooseExtractor ? true : false>();
    expect(true).to.equal(true);
  });
});
