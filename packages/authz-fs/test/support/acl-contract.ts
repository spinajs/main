import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { randomUUID } from 'node:crypto';

import type { AssignmentSubject, PrincipalRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import type { FileAclStore, FsAclRow } from '../../src/index.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

export const ALICE: PrincipalRef = { type: 'user', id: 'alice' };
export const BOB: PrincipalRef = { type: 'user', id: 'bob' };
export const TEAM: AssignmentSubject = { set: { role: 'team.member', scope: { type: 'team', id: 't1' } } };
export const ANY_USER: AssignmentSubject = { type: 'user', id: '*' };

const NOW = new Date('2030-01-01T00:00:00.000Z');
const LATER = new Date('2030-01-01T01:00:00.000Z');
const MUCH_LATER = new Date('2030-01-01T02:00:00.000Z');

/** What every FileAclStore must do. Each case uses filesystem names of its own, so no case cleans up. */
export function aclStoreContract(storeOf: () => FileAclStore): void {
  let s: FileAclStore;
  let fs: string;
  let other: string;
  let n = 0;

  beforeEach(() => {
    s = storeOf();
    fs = `c${++n}-${randomUUID().slice(0, 8)}`;
    other = `${fs}-b`;
  });

  const viewer = (path: string, subject: AssignmentSubject = ALICE, extra: Partial<FsAclRow> = {}): FsAclRow => ({ fs, path, subject, relation: 'viewer', ...extra });
  const present = async (f: string, path: string): Promise<boolean> => (await s.list(f, path)).length > 0;

  it('holds a live row of the relation at one of the paths for one of the subject keys', async () => {
    await s.grant(viewer('docs'));
    expect(await s.holds(fs, ['docs/a.txt', 'docs', ''], ['user:alice'], 'viewer', NOW)).to.equal(true);
    expect(await s.holds(fs, ['docs/a.txt', ''], ['user:alice'], 'viewer', NOW)).to.equal(false);
    expect(await s.holds(fs, ['docs'], ['user:bob'], 'viewer', NOW)).to.equal(false);
    expect(await s.holds(fs, ['docs'], ['user:alice'], 'editor', NOW)).to.equal(false);
    expect(await s.holds(other, ['docs'], ['user:alice'], 'viewer', NOW)).to.equal(false);
    expect(await s.holds(fs, [], ['user:alice'], 'viewer', NOW)).to.equal(false);
    expect(await s.holds(fs, ['docs'], [], 'viewer', NOW)).to.equal(false);
  });

  it('holds rows at the filesystem root, of subject sets and of the type wildcard', async () => {
    await s.grant(viewer('', TEAM));
    await s.grant(viewer('pub', ANY_USER));
    expect(await s.holds(fs, ['x.txt', ''], ['user:alice', 'team:t1#team.member'], 'viewer', NOW)).to.equal(true);
    expect(await s.holds(fs, ['pub'], ['user:alice', 'user:*'], 'viewer', NOW)).to.equal(true);
  });

  it('a row past its expiresAt does not hold', async () => {
    await s.grant(viewer('a.txt', ALICE, { expiresAt: LATER }));
    expect(await s.holds(fs, ['a.txt'], ['user:alice'], 'viewer', NOW)).to.equal(true);
    expect(await s.holds(fs, ['a.txt'], ['user:alice'], 'viewer', MUCH_LATER)).to.equal(false);
  });

  it('a row does not hold at exactly its expiresAt', async () => {
    await s.grant(viewer('a.txt', ALICE, { expiresAt: LATER }));
    expect(await s.holds(fs, ['a.txt'], ['user:alice'], 'viewer', LATER)).to.equal(false);
  });

  it('keeps paths exact and case-sensitive', async () => {
    await s.grant(viewer('Docs/a.txt', ALICE));
    await s.grant(viewer('docs/a.txt', BOB));
    expect((await s.list(fs, 'Docs/a.txt')).map((r) => r.subject)).to.deep.equal([ALICE]);
    expect((await s.list(fs, 'docs/a.txt')).map((r) => r.subject)).to.deep.equal([BOB]);
    expect(await s.holds(fs, ['docs/a.txt'], ['user:alice'], 'viewer', NOW)).to.equal(false);
    expect(await s.holds(fs, ['docs/a.txt'], ['user:bob'], 'viewer', NOW)).to.equal(true);
    await s.moveTree(fs, 'docs', fs, 'moved');
    expect(await present(fs, 'Docs/a.txt')).to.equal(true);
    expect(await present(fs, 'moved/a.txt')).to.equal(true);
    await s.grant(viewer('docs/b.txt'));
    await s.deleteTree(fs, 'docs');
    expect(await present(fs, 'docs/b.txt')).to.equal(false);
    expect(await present(fs, 'Docs/a.txt')).to.equal(true);
  });

  it('moveTree matches LIKE wildcards literally: a_b and 100% move only themselves', async () => {
    for (const path of ['a_b/in.txt', 'axb/x.txt', '100%/in.txt', '100x/y.txt']) await s.grant(viewer(path));
    await s.moveTree(fs, 'a_b', fs, 'to1');
    await s.moveTree(fs, '100%', fs, 'to2');
    expect(await present(fs, 'to1/in.txt')).to.equal(true);
    expect(await present(fs, 'to2/in.txt')).to.equal(true);
    for (const path of ['a_b/in.txt', '100%/in.txt']) expect(await present(fs, path), path).to.equal(false);
    for (const path of ['axb/x.txt', '100x/y.txt']) expect(await present(fs, path), path).to.equal(true);
  });

  it('grant is idempotent on (fs, path, subject, relation) and list decodes every subject form', async () => {
    await s.grant(viewer('a.txt', ALICE, { grantedBy: 'user:root' }));
    await s.grant(viewer('a.txt', ALICE, { expiresAt: LATER }));
    await s.grant(viewer('a.txt', ANY_USER));
    await s.grant({ fs, path: 'a.txt', subject: TEAM, relation: 'editor', grantedBy: 'user:root' });
    expect(await s.list(fs, 'a.txt')).to.have.deep.members([
      { fs, path: 'a.txt', subject: ALICE, relation: 'viewer', expiresAt: LATER },
      { fs, path: 'a.txt', subject: ANY_USER, relation: 'viewer' },
      { fs, path: 'a.txt', subject: TEAM, relation: 'editor', grantedBy: 'user:root' },
    ]);
  });

  it('normalises paths', async () => {
    await s.grant(viewer('./docs//a.txt'));
    expect(await s.list(fs, 'docs\\a.txt')).to.have.length(1);
    expect((await s.list(fs, 'docs/a.txt'))[0].path).to.equal('docs/a.txt');
  });

  it('revoke removes that row only', async () => {
    await s.grant(viewer('a.txt'));
    await s.grant(viewer('a.txt', BOB));
    await s.grant({ ...viewer('a.txt'), relation: 'editor' });
    await s.revoke(fs, 'a.txt', 'user:alice', 'viewer');
    expect((await s.list(fs, 'a.txt')).map((r) => `${JSON.stringify(r.subject)} ${r.relation}`).sort()).to.deep.equal(['{"type":"user","id":"alice"} editor', '{"type":"user","id":"bob"} viewer']);
  });

  it('setOwnerIfAbsent keeps the first owner; ownerOf reads it', async () => {
    expect(await s.ownerOf(fs, 'o.txt')).to.equal(null);
    await s.setOwnerIfAbsent(fs, 'o.txt', ALICE);
    await s.setOwnerIfAbsent(fs, 'o.txt', BOB);
    expect(await s.ownerOf(fs, 'o.txt')).to.deep.equal(ALICE);
    expect((await s.list(fs, 'o.txt')).map((r) => r.relation)).to.deep.equal(['owner']);
    expect(await s.ownerOf(fs, 'o')).to.equal(null);
  });

  it('ownerOf skips owner rows of sets and wildcards', async () => {
    await s.grant({ fs, path: 'w.txt', subject: ANY_USER, relation: 'owner' });
    await s.grant({ fs, path: 'w.txt', subject: TEAM, relation: 'owner' });
    expect(await s.ownerOf(fs, 'w.txt')).to.equal(null);
  });

  it('deletePath takes that path only; deleteTree the path and everything under it, not siblings by prefix', async () => {
    const paths = ['d', 'd/a.txt', 'd/sub/b.txt', 'd-x.txt', 'dd/c.txt', 'd.txt'];
    for (const path of paths) await s.grant(viewer(path));
    await s.grant({ ...viewer('d/a.txt'), fs: other });
    await s.deletePath(fs, 'd');
    expect(await present(fs, 'd')).to.equal(false);
    expect(await present(fs, 'd/a.txt')).to.equal(true);
    await s.deleteTree(fs, 'd');
    for (const path of ['d/a.txt', 'd/sub/b.txt']) expect(await present(fs, path), path).to.equal(false);
    for (const path of ['d-x.txt', 'dd/c.txt', 'd.txt']) expect(await present(fs, path), path).to.equal(true);
    expect(await present(other, 'd/a.txt')).to.equal(true);
    await s.deleteTree(fs, '');
    for (const path of paths) expect(await present(fs, path), path).to.equal(false);
    expect(await present(other, 'd/a.txt')).to.equal(true);
  });

  it('matches LIKE wildcards in directory paths literally: a_b, 100% and docs[1] take only themselves', async () => {
    for (const path of ['a_b', 'a_b/in.txt', 'axb/x.txt', '100%', '100%/in.txt', '100x/y.txt', 'docs[1]', 'docs[1]/in.txt', 'docs1/z.txt']) await s.grant(viewer(path));
    for (const path of ['a_b', '100%', 'docs[1]']) await s.deleteTree(fs, path);
    for (const path of ['a_b/in.txt', '100%/in.txt', 'docs[1]/in.txt']) expect(await present(fs, path), path).to.equal(false);
    for (const path of ['axb/x.txt', '100x/y.txt', 'docs1/z.txt']) expect(await present(fs, path), path).to.equal(true);
  });

  it('moveTree carries the rows at a path and under it, across filesystems too; a moved row replaces an equal one', async () => {
    for (const path of ['m', 'm/a.txt', 'm/sub/b.txt', 'm-x.txt']) await s.grant(viewer(path));
    await s.grant({ ...viewer('n/a.txt', ALICE, { grantedBy: 'user:old' }), fs: other });
    await s.moveTree(fs, 'm', other, 'n');
    for (const path of ['n', 'n/a.txt', 'n/sub/b.txt']) expect(await present(other, path), path).to.equal(true);
    for (const path of ['m', 'm/a.txt', 'm/sub/b.txt']) expect(await present(fs, path), path).to.equal(false);
    expect(await present(fs, 'm-x.txt')).to.equal(true);
    expect(await s.list(other, 'n/a.txt')).to.deep.equal([{ fs: other, path: 'n/a.txt', subject: ALICE, relation: 'viewer' }]);

    await s.moveTree(other, 'n', other, 'p/q');
    expect(await present(other, 'p/q/sub/b.txt')).to.equal(true);
    await s.moveTree(other, 'p/q', other, 'p/q');
    expect(await present(other, 'p/q')).to.equal(true);
  });

  it('moveTree refuses a move into its own subtree', async () => {
    await s.grant(viewer('p'));
    await expect(s.moveTree(fs, 'p', fs, 'p/q')).to.be.rejectedWith(InvalidArgument);
    expect(await present(fs, 'p')).to.equal(true);
  });

  it('movePath moves exactly the rows of that path, across filesystems too, never those under it', async () => {
    for (const path of ['k', 'k/a.txt', 'k-x.txt']) await s.grant(viewer(path));
    await s.movePath(fs, 'k', other, 'n');
    expect(await s.list(other, 'n')).to.deep.equal([{ fs: other, path: 'n', subject: ALICE, relation: 'viewer' }]);
    for (const path of ['k/a.txt', 'k-x.txt']) expect(await present(fs, path), path).to.equal(true);
    expect(await present(fs, 'k')).to.equal(false);
    await s.movePath(other, 'n', other, 'n');
    expect(await present(other, 'n')).to.equal(true);
  });

  // The destination's row for the same (subject, relation) is deleted first, so the unique key never collides.
  it('movePath onto a path holding an equal row replaces it and keeps the others', async () => {
    await s.grant(viewer('a.txt', ALICE, { expiresAt: LATER }));
    await s.grant(viewer('b.txt', ALICE, { grantedBy: 'user:old' }));
    await s.grant(viewer('b.txt', BOB));
    await s.movePath(fs, 'a.txt', fs, 'b.txt');
    expect(await present(fs, 'a.txt')).to.equal(false);
    expect(await s.list(fs, 'b.txt')).to.have.deep.members([
      { fs, path: 'b.txt', subject: ALICE, relation: 'viewer', expiresAt: LATER },
      { fs, path: 'b.txt', subject: BOB, relation: 'viewer' },
    ]);
  });

  it('refuses a malformed filesystem name, path or relation, and values longer than their columns', async () => {
    await expect(s.grant({ ...viewer('a.txt'), fs: 'a:b' })).to.be.rejectedWith(InvalidArgument);
    await expect(s.grant({ ...viewer('a.txt'), fs: '' })).to.be.rejectedWith(InvalidArgument);
    await expect(s.grant(viewer('../a.txt'))).to.be.rejectedWith(InvalidArgument);
    await expect(s.grant(viewer(`d/${'x'.repeat(520)}`))).to.be.rejectedWith(InvalidArgument);
    await expect(s.grant({ ...viewer('a.txt'), relation: '' })).to.be.rejectedWith(InvalidArgument);
    await expect(s.grant({ ...viewer('a.txt'), relation: 'r'.repeat(65) })).to.be.rejectedWith(InvalidArgument);
    await expect(s.grant(viewer('a.txt', { type: 'user', id: 'x'.repeat(200) }))).to.be.rejectedWith(InvalidArgument);
    await expect(s.grant(viewer('a.txt', ALICE, { expiresAt: new Date('nope') }))).to.be.rejectedWith(InvalidArgument);
    await expect(s.setOwnerIfAbsent(fs, 'a.txt', { type: 'user', id: '' })).to.be.rejectedWith(InvalidArgument);
    expect(await present(fs, 'a.txt')).to.equal(false);
  });
}
