import * as chai from 'chai';
import 'mocha';

import type { ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { FILE_PROVIDER_INSTANCES } from '@spinajs/fs';

import { fromFsPath } from '../src/index.js';
import type { FsAccessConfig, FsAccessMode, FsSignedUrlConfig } from '../src/index.js';

const expect = chai.expect;

describe('authz-fs fromFsPath', () => {
  const extract = (req: unknown, fsName = 'uploads', param = 'path') => fromFsPath(fsName, param)(req);

  const published = (provider: object, run: () => void): void => {
    const hadMap = DI.RootContainer.Cache.has(FILE_PROVIDER_INSTANCES);
    DI.register(provider).asMapValue(FILE_PROVIDER_INSTANCES, 'uploads');
    try {
      run();
    } finally {
      (DI.get(FILE_PROVIDER_INSTANCES) as Map<string, unknown>).delete('uploads');
      if (!hadMap) DI.uncache(FILE_PROVIDER_INSTANCES);
    }
  };

  it('gives the file ref of the url parameter, normalised as the fs core does', () => {
    expect(extract({ params: { path: 'docs/a.txt' } })).to.deep.equal({ type: 'file', id: 'uploads:docs/a.txt' });
    expect(extract({ params: { path: './docs//b.txt' } })).to.deep.equal({ type: 'file', id: 'uploads:docs/b.txt' });
    expect(extract({ params: { path: 'docs\\c.txt' } })).to.deep.equal({ type: 'file', id: 'uploads:docs/c.txt' });
    expect(extract({ params: { 0: 'docs/d.txt' } }, 'uploads', '0')).to.deep.equal({ type: 'file', id: 'uploads:docs/d.txt' });
  });

  it('reads a rooted path from the filesystem root, and gives the fs ref for the root itself', () => {
    expect(extract({ params: { path: '/docs/a.txt' } })).to.deep.equal({ type: 'file', id: 'uploads:docs/a.txt' });
    for (const path of ['/', '.', '']) expect(extract({ params: { path } }), JSON.stringify(path)).to.deep.equal({ type: 'fs', id: 'uploads' });
  });

  it('makes an absolute path inside the published BasePath relative to it', () => {
    published({ Name: 'uploads', BasePath: 'C:\\srv\\uploads' }, () => {
      expect(extract({ params: { path: 'C:\\srv\\uploads\\docs\\a.txt' } })).to.deep.equal({ type: 'file', id: 'uploads:docs/a.txt' });
      expect(() => extract({ params: { path: 'C:\\srv\\other\\a.txt' } })).to.throw(InvalidArgument);
    });
  });

  it('reads the published base path from the container it is given', () => {
    const child = DI.child();
    child.register({ Name: 'uploads', BasePath: 'C:\\srv\\child' }).asMapValue(FILE_PROVIDER_INSTANCES, 'uploads');
    const req = { params: { path: 'C:\\srv\\child\\docs\\a.txt' } };
    expect(fromFsPath('uploads', 'path', child)(req)).to.deep.equal({ type: 'file', id: 'uploads:docs/a.txt' });
    expect(() => fromFsPath('uploads', 'path')(req)).to.throw(InvalidArgument);
  });

  it('refuses .. above the root and other refused paths with InvalidArgument (400)', () => {
    for (const path of ['../a.txt', 'docs/../../a.txt', 'x\0y', 'a.txt::$DATA', 'D:\\a.txt']) {
      expect(() => extract({ params: { path } }), JSON.stringify(path)).to.throw(InvalidArgument);
    }
  });

  it('joins the segments of an Express 5 wildcard parameter (*path) with /', () => {
    expect(extract({ params: { path: ['docs', 'a.txt'] } })).to.deep.equal({ type: 'file', id: 'uploads:docs/a.txt' });
    expect(extract({ params: { path: ['a.txt'] } })).to.deep.equal({ type: 'file', id: 'uploads:a.txt' });
  });

  it('refuses a wildcard parameter that is empty, holds a non-string, or has a segment the normaliser refuses', () => {
    for (const path of [[], ['docs', 1], ['docs', null], ['..', 'a.txt'], ['docs', '..', 'a.txt'], ['docs', 'a\0b'], ['docs', 'x::$DATA'], ['docs', '../../a.txt'], ['docs', ''], ['docs', 'a/b'], ['docs', 'a\\b']]) {
      expect(() => extract({ params: { path } }), JSON.stringify(path)).to.throw(InvalidArgument);
    }
  });

  it('refuses a missing or non-string parameter, and reads url parameters only', () => {
    for (const req of [{ params: {} }, { params: { path: 7 } }, { params: { path: { 0: 'a' } } }, { params: { other: 'a' } }, { query: { path: 'a.txt' } }, { params: {}, query: { path: 'a.txt' } }, {}, null, undefined, 'a.txt']) {
      expect(() => extract(req), JSON.stringify(req)).to.throw(InvalidArgument, /url parameter path/);
    }
    expect(() => extract({ params: Object.create({ path: 'a.txt' }) })).to.throw(InvalidArgument);
  });

  it('refuses a filesystem name or a parameter name it cannot use when it is built', () => {
    for (const [fsName, param] of [
      ['', 'path'],
      ['a:b', 'path'],
      ['uploads', ''],
    ]) {
      expect(() => fromFsPath(fsName, param), `${fsName} ${param}`).to.throw(InvalidArgument);
    }
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const yes = <_T extends true>(): void => {};

// authz-http's ResourceExtractor with the request widened, so this test needs no authz-http.
type LooseExtractor = (req: any) => ResourceRef | object | Promise<ResourceRef | object>;

describe('authz-fs pinned shapes: config and fromFsPath', () => {
  it('match the design exactly', () => {
    yes<Equal<FsAccessMode, 'off' | 'audit' | 'enforce'>>();
    yes<Equal<FsAccessConfig, { readonly mode: FsAccessMode; readonly domain: string; readonly stampOwner?: boolean; readonly list?: 'dir' | 'each'; readonly signedUrl?: FsSignedUrlConfig }>>();
    yes<Equal<FsSignedUrlConfig, { readonly maxTtlSeconds?: number; readonly defaultTtlSeconds?: number }>>();
    yes<Equal<typeof fromFsPath, (fsName: string, param: string, container?: IContainer) => (req: unknown) => ResourceRef | Promise<ResourceRef>>>();
    yes<ReturnType<typeof fromFsPath> extends LooseExtractor ? true : false>();
    expect(true).to.equal(true);
  });
});
