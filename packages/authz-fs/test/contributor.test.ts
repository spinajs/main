import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { PermissionRefDecl } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { FS_OPERATIONS, FsAuthzContributor } from '../src/index.js';
import { configuredChild } from './helpers.js';

const expect = chai.expect;

const refs = async (container: IContainer, domain: string): Promise<readonly PermissionRefDecl[]> => (await new FsAuthzContributor(container).contribute(domain)).permissionRefs ?? [];

const tableRefs = (fsName: string): string[] => {
  const out = new Set<string>();
  for (const op of Object.values(FS_OPERATIONS)) for (const p of op.paths) for (const permission of p.permissions) out.add(`${permission} ${p.kind} authz.fs.${fsName}`);
  return [...out].sort();
};

const show = (list: readonly PermissionRefDecl[]) => list.map((r) => `${r.permission} ${r.type} ${r.source}`).sort();

describe('authz-fs FsAuthzContributor', () => {
  let child: IContainer | undefined;

  afterEach(async () => {
    await child?.dispose();
    child = undefined;
  });

  it('is registered in the root container as an AuthzContributor', () => {
    expect(DI.RootContainer.getRegisteredTypes(AuthzContributor)).to.include(FsAuthzContributor);
  });

  it('gives a domain the permissions of the operation table of each filesystem it checks', async () => {
    child = await configuredChild({ uploads: { mode: 'enforce' }, archive: { mode: 'audit', domain: 'fs' }, scratch: { mode: 'off' } });
    expect(show(await refs(child, 'root'))).to.deep.equal(tableRefs('uploads'));
    expect(show(await refs(child, 'fs'))).to.deep.equal(tableRefs('archive'));
    expect(await refs(child, 'other')).to.deep.equal([]);
  });

  it('adds the permissions of authz.fs.<name>.operations, sourced at that key', async () => {
    child = await configuredChild({ uploads: { mode: 'enforce', operations: { compact: 'fs:compact', read: ['fs:read', 'app:audit'] } } });
    const list = show(await refs(child, 'root'));
    expect(list).to.include('fs:compact file authz.fs.uploads.operations.compact');
    expect(list).to.include('app:audit file authz.fs.uploads.operations.read');
    expect(list).to.include('fs:read file authz.fs.uploads.operations.read');
  });

  it("skips filesystems with mode 'off' and gives nothing without authz.fs", async () => {
    child = await configuredChild({ scratch: { mode: 'off', operations: { compact: 'fs:compact' } } });
    expect(await refs(child, 'root')).to.deep.equal([]);
    await child.dispose();
    child = await configuredChild(undefined);
    expect(await refs(child, 'root')).to.deep.equal([]);
  });

  it('fails on an invalid entry', async () => {
    child = await configuredChild({ uploads: { mode: 'enforce', operations: { compact: 42 } } });
    let error: unknown;
    try {
      await refs(child, 'root');
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(AuthzConfigError);
  });
});
