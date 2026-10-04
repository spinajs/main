import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, RelationResolver } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { FileMetadataStore, FsOwnerRelation, FsResourceAdapter, fileMetadataStore } from '../src/index.js';
import { configuredChild } from './helpers.js';
import { MemoryFileMetadataStore } from './support/memory-store.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');

describe('authz-fs owner relation (D10)', () => {
  let child: IContainer;
  let store: MemoryFileMetadataStore;
  let adapter: FsResourceAdapter;

  const holds = async (principal: Principal, type: string, id: string, subject?: unknown): Promise<boolean> => {
    const relation = adapter.relations().find((r) => r.type === type && r.relation === 'owner');
    if (!relation) throw new Error(`no owner relation for ${type}`);
    return relation.holds(principal, { type, id }, subject);
  };

  beforeEach(async () => {
    child = await configuredChild({ uploads: { mode: 'enforce', metadata: 'MemoryFileMetadataStore', stampOwner: true }, plain: { mode: 'enforce' }, broken: { mode: 'enforce', metadata: 'NoSuchStore' } });
    store = new MemoryFileMetadataStore();
    child.register(testHost.instance(store)).as(FileMetadataStore);
    adapter = new FsResourceAdapter(child);
    await store.set('uploads', 'docs/a.txt', { owner: { type: 'user', id: 'alice' } });
    await store.set('uploads', 'docs', { owner: { type: 'user', id: 'bob' } });
    await store.set('plain', 'docs/a.txt', { owner: { type: 'user', id: 'alice' } });
  });

  afterEach(async () => {
    await child.dispose();
  });

  it('FsResourceAdapter.relations() serves owner on file, dir and fs (boot rule 8 asks for every type of the permission)', () => {
    const relations = adapter.relations();
    expect(relations.map((r) => `${r.type}#${r.relation}`).sort()).to.deep.equal(['dir#owner', 'file#owner', 'fs#owner']);
    for (const r of relations) {
      expect(r).to.be.instanceOf(RelationResolver);
      expect(r).to.be.instanceOf(FsOwnerRelation);
    }
    expect(adapter.relations()).to.deep.equal(relations);
  });

  it('holds when the stored owner is the principal, by type and id', async () => {
    expect(await holds(alice, 'file', 'uploads:docs/a.txt')).to.equal(true);
    expect(await holds(bob, 'dir', 'uploads:docs')).to.equal(true);
    expect(await holds(bob, 'file', 'uploads:docs/a.txt')).to.equal(false);
    expect(await holds({ ...alice, type: 'agent' }, 'file', 'uploads:docs/a.txt')).to.equal(false);
  });

  it('does not hold for a path without a row, for the filesystem root or for a ref of another type', async () => {
    expect(await holds(alice, 'file', 'uploads:docs/b.txt')).to.equal(false);
    expect(await holds(alice, 'fs', 'uploads')).to.equal(false);
    expect(await holds(alice, 'file', 'uploads:a/../../x')).to.equal(false);
    const fileOwner = adapter.relations().find((r) => r.type === 'file')!;
    expect(await fileOwner.holds(alice, { type: 'dir', id: 'uploads:docs/a.txt' })).to.equal(false);
    expect(await fileOwner.holds(alice, { type: 'doc', id: 'uploads:docs/a.txt' })).to.equal(false);
  });

  it('reads the store, never the subject: a subject that claims an owner changes nothing', async () => {
    const forged = { id: 'uploads:docs/b.txt', type: 'file', fs: 'uploads', path: 'docs/b.txt', owner: { type: 'user', id: 'alice' } };
    expect(await holds(alice, 'file', 'uploads:docs/b.txt', forged)).to.equal(false);
    expect(await holds(bob, 'file', 'uploads:docs/a.txt', { owner: { type: 'user', id: 'bob' } })).to.equal(false);
  });

  it('does not hold on a filesystem without a metadata store, and never for SYSTEM-like principals', async () => {
    expect(await holds(alice, 'file', 'plain:docs/a.txt')).to.equal(false);
    expect(await holds(alice, 'file', 'unconfigured:docs/a.txt')).to.equal(false);
    await store.set('uploads', 'u.txt', { owner: { type: 'unattended', id: 'unattended' } });
    expect(await holds({ ...alice, type: 'unattended', id: 'unattended' }, 'file', 'uploads:u.txt')).to.equal(false);
  });

  it('throws AuthzConfigError when the configured store is not registered', async () => {
    const e = await holds(alice, 'file', 'broken:a.txt').catch((err: unknown) => err);
    expect(e).to.be.instanceOf(AuthzConfigError);
    expect((e as Error).message).to.contain('authz.fs.broken.metadata').and.contain('NoSuchStore');
  });

  it('fileMetadataStore picks the registered store by class name, undefined without config', async () => {
    expect(await fileMetadataStore('uploads', child)).to.equal(store);
    expect(await fileMetadataStore('plain', child)).to.equal(undefined);
    expect(await fileMetadataStore('unconfigured', child)).to.equal(undefined);
    expect(await fileMetadataStore('broken', child).catch((e: unknown) => e)).to.be.instanceOf(AuthzConfigError);
  });
});
