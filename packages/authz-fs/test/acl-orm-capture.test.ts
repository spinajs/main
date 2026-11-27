import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { DI } from '@spinajs/di';
import { WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '@spinajs/orm';

import { AuthzFsAcl_2026_10_17_00_00_00, FS_ACL_CONNECTION, FsAclRecord, OrmFileAclStore } from '../src/index.js';
import { aclPathHash } from '../src/acl/shared.js';
import { ALICE, BOB } from './support/acl-contract.js';
import { bootAclOrm, sqlite } from './support/acl-orm.js';
import type { AclOrm } from './support/acl-orm.js';

const expect = chai.expect;

const LATER = new Date('2030-01-01T01:00:00.000Z');

// Module state, not instance state: the test does not depend on which instance DI hands the capture.
const seen: CapturedWrite[] = [];

class AclWrites extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === FsAclRecord ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    seen.push(write);
  }
}

/** The id of every row inserted so far, by `<path> <subject key>`. */
function insertedIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const w of seen) {
    if (w.kind !== 'insert') continue;
    for (const r of w.rows) if (typeof r.after?.path === 'string' && typeof r.after.subject_key === 'string') ids.set(`${r.after.path} ${r.after.subject_key}`, r.id);
  }
  return ids;
}

describe('authz-fs OrmFileAclStore: writes reach the ORM write capture', function () {
  this.timeout(30000);

  let env: AclOrm | undefined;
  let fs: string;
  const store = new OrmFileAclStore();

  before(async () => {
    env = await bootAclOrm({ DefaultConnection: 'main', Connections: [sqlite('main')], Aliases: { [FS_ACL_CONNECTION]: 'default' } });
    await new AuthzFsAcl_2026_10_17_00_00_00().up(env.orm.Connections.get('default')!);
    await env.orm.reloadTableInfo({ models: [FsAclRecord] });
    DI.register(AclWrites).as(WriteObserver);
  });

  after(async () => {
    DI.unregister(AclWrites);
    await env?.close();
  });

  beforeEach(() => {
    fs = `cap-${randomUUID().slice(0, 8)}`;
    seen.length = 0;
  });

  it('grant inserts one row, keyed by the id the store assigned', async () => {
    await store.grant({ fs, path: 'a.txt', subject: ALICE, relation: 'viewer' });
    expect(seen.map((w) => w.kind)).to.deep.equal(['insert']);
    const [insert] = seen;
    expect(insert.model).to.equal(FsAclRecord);
    expect(insert.unknownKeys).to.equal(false);
    expect(insert.keylessRows).to.equal(0);
    expect(insert.rows).to.have.length(1);
    const [row] = insert.rows;
    expect(row.id).to.have.length(36);
    expect(row.before).to.equal(undefined);
    expect(row.after).to.include({ id: row.id, fs, path: 'a.txt', path_hash: aclPathHash('a.txt'), subject_key: 'user:alice', relation: 'viewer', expires_at: null, granted_by: null });
  });

  it('a second grant updates that row', async () => {
    await store.grant({ fs, path: 'a.txt', subject: ALICE, relation: 'viewer' });
    await store.grant({ fs, path: 'a.txt', subject: ALICE, relation: 'viewer', expiresAt: LATER, grantedBy: 'user:root' });
    expect(seen.map((w) => w.kind)).to.deep.equal(['insert', 'update']);
    const [insert, update] = seen;
    expect(update.rows.map((r) => r.id)).to.deep.equal([insert.rows[0].id]);
    expect(update.rows[0].before).to.include({ expires_at: null, granted_by: null });
    expect(update.rows[0].after).to.include({ granted_by: 'user:root' });
    expect(update.rows[0].after?.expires_at).to.not.equal(null);
  });

  it('setOwnerIfAbsent inserts the owner row once', async () => {
    await store.setOwnerIfAbsent(fs, 'o.txt', ALICE);
    await store.setOwnerIfAbsent(fs, 'o.txt', BOB);
    expect(seen.map((w) => w.kind)).to.deep.equal(['insert']);
    expect(seen[0].rows[0].after).to.include({ path: 'o.txt', subject_key: 'user:alice', relation: 'owner' });
  });

  it('revoke, deletePath and deleteTree delete rows under their ids', async () => {
    await store.grant({ fs, path: 'd/a.txt', subject: ALICE, relation: 'viewer' });
    await store.grant({ fs, path: 'd/a.txt', subject: BOB, relation: 'viewer' });
    await store.grant({ fs, path: 'd/b.txt', subject: ALICE, relation: 'viewer' });
    await store.grant({ fs, path: 'd/c.txt', subject: ALICE, relation: 'viewer' });
    const ids = insertedIds();
    seen.length = 0;

    await store.revoke(fs, 'd/a.txt', 'user:bob', 'viewer');
    await store.deletePath(fs, 'd/b.txt');
    await store.deleteTree(fs, 'd');

    expect(seen.map((w) => w.kind)).to.deep.equal(['delete', 'delete', 'delete']);
    expect(seen[0].rows.map((r) => r.id)).to.deep.equal([ids.get('d/a.txt user:bob')]);
    expect(seen[1].rows.map((r) => r.id)).to.deep.equal([ids.get('d/b.txt user:alice')]);
    expect(seen[2].rows.map((r) => r.id)).to.have.members([ids.get('d/a.txt user:alice'), ids.get('d/c.txt user:alice')]);
    expect(seen.flatMap((w) => w.rows).every((r) => r.before !== undefined && r.after === undefined)).to.equal(true);
  });

  it('moveTree deletes the replaced row and updates each moved row under its id', async () => {
    await store.grant({ fs, path: 'm/a.txt', subject: ALICE, relation: 'viewer' });
    await store.grant({ fs, path: 'm/b.txt', subject: BOB, relation: 'viewer' });
    await store.grant({ fs, path: 'n/a.txt', subject: ALICE, relation: 'viewer' });
    const ids = insertedIds();
    seen.length = 0;

    await store.moveTree(fs, 'm', fs, 'n');

    expect(seen.map((w) => w.kind)).to.deep.equal(['delete', 'update', 'update']);
    expect(seen[0].rows.map((r) => r.id)).to.deep.equal([ids.get('n/a.txt user:alice')]);
    const moved = seen.slice(1).flatMap((w) => w.rows.map((r) => ({ id: r.id, from: r.before?.path, to: r.after?.path, hash: r.after?.path_hash })));
    expect(moved).to.have.deep.members([
      { id: ids.get('m/a.txt user:alice'), from: 'm/a.txt', to: 'n/a.txt', hash: aclPathHash('n/a.txt') },
      { id: ids.get('m/b.txt user:bob'), from: 'm/b.txt', to: 'n/b.txt', hash: aclPathHash('n/b.txt') },
    ]);
  });

  it('movePath updates every row of the path in one statement, each under its id', async () => {
    await store.grant({ fs, path: 'p.txt', subject: ALICE, relation: 'viewer' });
    await store.grant({ fs, path: 'p.txt', subject: BOB, relation: 'viewer' });
    const ids = insertedIds();
    seen.length = 0;

    await store.movePath(fs, 'p.txt', fs, 'q.txt');

    expect(seen.map((w) => w.kind)).to.deep.equal(['update']);
    expect(seen[0].keylessRows).to.equal(0);
    expect(seen[0].rows.map((r) => ({ id: r.id, from: r.before?.path, to: r.after?.path }))).to.have.deep.members([
      { id: ids.get('p.txt user:alice'), from: 'p.txt', to: 'q.txt' },
      { id: ids.get('p.txt user:bob'), from: 'p.txt', to: 'q.txt' },
    ]);
  });

  it('a read is no captured statement', async () => {
    await store.grant({ fs, path: 'r.txt', subject: ALICE, relation: 'owner' });
    seen.length = 0;
    expect(await store.holds(fs, ['r.txt'], ['user:alice'], 'owner', new Date())).to.equal(true);
    expect(await store.list(fs, 'r.txt')).to.have.length(1);
    expect(await store.ownerOf(fs, 'r.txt')).to.deep.equal(ALICE);
    expect(seen).to.deep.equal([]);
  });
});
