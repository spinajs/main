import * as chai from 'chai';
import 'mocha';
import { createHash } from 'node:crypto';

import type { AssignmentSubject, PrincipalRef } from '@spinajs/authz';

import { FS_ACL_LIMITS, FS_ACL_TABLE, FileAclStore } from '../src/index.js';
import type { FsAclRow } from '../src/index.js';
import { aclPathChain, aclPathHash, movedPath } from '../src/acl/shared.js';
import { aclStoreContract } from './support/acl-contract.js';
import { MemoryFileAclStore } from './support/memory-acl-store.js';

const expect = chai.expect;

describe('authz-fs FileAclStore contract: MemoryFileAclStore (test double)', () => {
  aclStoreContract(() => new MemoryFileAclStore());
});

describe('authz-fs ACL helpers', () => {
  it('aclPathChain gives the path, its parents nearest first, then the root', () => {
    expect(aclPathChain('a/b/c.txt')).to.deep.equal(['a/b/c.txt', 'a/b', 'a', '']);
    expect(aclPathChain('a')).to.deep.equal(['a', '']);
    expect(aclPathChain('')).to.deep.equal(['']);
  });

  it('movedPath keeps what follows the moved root', () => {
    expect(movedPath('a', 'x', 'a')).to.equal('x');
    expect(movedPath('a', 'x', 'a/b/c')).to.equal('x/b/c');
    expect(movedPath('a', '', 'a/b')).to.equal('b');
    expect(movedPath('', 'x', 'b')).to.equal('x/b');
  });

  it('aclPathHash is the sha256 hex of the normalised path, so case variants hash apart', () => {
    expect(aclPathHash('docs/a.txt')).to.equal(createHash('sha256').update('docs/a.txt', 'utf8').digest('hex'));
    expect(aclPathHash('')).to.have.length(64);
    expect(aclPathHash('Docs/A.txt')).to.not.equal(aclPathHash('docs/a.txt'));
  });

  it('names the table and its column limits', () => {
    expect(FS_ACL_TABLE).to.equal('fs_acl');
    expect(FS_ACL_LIMITS).to.deep.equal({ fs: 64, path: 512, subject_key: 200, relation: 64, granted_by: 100 });
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Shape<C> = Pick<C, keyof C>;
const yes = <_T extends true>(): void => {};

describe('authz-fs pinned shapes: FileAclStore', () => {
  it('matches C3', () => {
    yes<Equal<FsAclRow, { readonly fs: string; readonly path: string; readonly subject: AssignmentSubject; readonly relation: string; readonly expiresAt?: Date; readonly grantedBy?: string }>>();
    yes<
      Equal<
        Shape<FileAclStore>,
        {
          holds(fs: string, paths: readonly string[], subjectKeys: readonly string[], relation: string, at: Date): Promise<boolean>;
          list(fs: string, path: string): Promise<readonly FsAclRow[]>;
          grant(row: FsAclRow): Promise<void>;
          revoke(fs: string, path: string, subjectKey: string, relation: string): Promise<void>;
          ownerOf(fs: string, path: string): Promise<PrincipalRef | null>;
          setOwnerIfAbsent(fs: string, path: string, owner: PrincipalRef): Promise<void>;
          deleteTree(fs: string, path: string): Promise<void>;
          deletePath(fs: string, path: string): Promise<void>;
          moveTree(fromFs: string, from: string, toFs: string, to: string): Promise<void>;
          movePath(fromFs: string, from: string, toFs: string, to: string): Promise<void>;
        }
      >
    >();
    expect(true).to.equal(true);
  });
});
