import { expect } from 'chai';
import * as sinon from 'sinon';
import { DateTime } from 'luxon';
import { SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DefaultQueueService } from '@spinajs/queue';

import { UserMetadata, UserMetadataOwnerRelation } from '../src/index.js';
import { bootUsersDb, registerUsersTestHost, releaseUsersHost, seedUser, setIdentityFlags } from './support/users-db.js';

const OWNER_UUID = '0b8f7e7a-41f1-4b67-9c3e-6a1d2c3b4e5f';
const OTHER_UUID = '6f1c1c55-3c1e-4a8f-9b9a-2f4f0c1d2e3a';

/** users.Id by Uuid without a database. */
class StubbedOwnerRelation extends UserMetadataOwnerRelation {
  public readonly lookups: string[] = [];

  protected async userIdOf(uuid: string): Promise<unknown> {
    this.lookups.push(uuid);
    return { [OWNER_UUID]: 7, [OTHER_UUID]: 8 }[uuid];
  }
}

function principal(type: string, id: string, extra: Partial<Principal> = {}): Principal {
  return { type, id, authenticated: true, source: 'session', attributes: {}, ...extra };
}

function row(userId: unknown, id?: number): UserMetadata {
  const m = new UserMetadata();
  m.Key = 'user:note';
  m.user_id = userId as number;
  if (id !== undefined) m.Id = id;
  return m;
}

describe('user.metadata owner relation', () => {
  const owner = principal('user', OWNER_UUID);

  it("is relation 'owner' of type 'user.metadata'", () => {
    const r = new StubbedOwnerRelation();

    expect(r.type).to.eq('user.metadata');
    expect(r.relation).to.eq('owner');
  });

  it('holds on a row whose user_id is the principal user, on a type-level ref and on the ref of that row', async () => {
    const r = new StubbedOwnerRelation();

    expect(await r.holds(owner, { type: 'user.metadata' }, row(7))).to.eq(true);
    expect(await r.holds(owner, { type: 'user.metadata', id: '41' }, row(7, 41))).to.eq(true);
    // Postgres returns a bigint column as a string.
    expect(await r.holds(owner, { type: 'user.metadata' }, row('7'))).to.eq(true);
  });

  it("never holds on another user's row", async () => {
    const r = new StubbedOwnerRelation();

    expect(await r.holds(owner, { type: 'user.metadata' }, row(8))).to.eq(false);
    expect(await r.holds(principal('user', OTHER_UUID), { type: 'user.metadata' }, row(7))).to.eq(false);
  });

  it('never holds without a row, or on a subject that is not a metadata row', async () => {
    const r = new StubbedOwnerRelation();

    expect(await r.holds(owner, { type: 'user.metadata' })).to.eq(false);
    expect(await r.holds(owner, { type: 'user.metadata', id: '41' })).to.eq(false);
    expect(await r.holds(owner, { type: 'user.metadata' }, { Uuid: OWNER_UUID, Id: 7 })).to.eq(false);
    expect(await r.holds(owner, { type: 'user.metadata' }, { user_id: 'seven' })).to.eq(false);
    expect(await r.holds(owner, { type: 'user.metadata' }, null)).to.eq(false);
  });

  it('refuses a ref that names another row than the subject', async () => {
    const r = new StubbedOwnerRelation();

    expect(await r.holds(owner, { type: 'user.metadata', id: '42' }, row(7, 41))).to.eq(false);
    expect(await r.holds(owner, { type: 'user.metadata', id: '41' }, row(7))).to.eq(false);
  });

  it('never holds for a principal that is not a user, nor through onBehalfOf', async () => {
    const r = new StubbedOwnerRelation();

    expect(await r.holds(principal('service', OWNER_UUID), { type: 'user.metadata' }, row(7))).to.eq(false);
    expect(await r.holds(SYSTEM, { type: 'user.metadata' }, row(7))).to.eq(false);
    expect(await r.holds(principal('agent', 'a-1', { onBehalfOf: owner, delegation: 'inherit' }), { type: 'user.metadata' }, row(7))).to.eq(false);
    expect(r.lookups, 'no lookup for a principal that is not a user').to.deep.eq([]);
  });

  it('never holds for a principal whose account is gone', async () => {
    const r = new StubbedOwnerRelation();

    expect(await r.holds(principal('user', 'gone'), { type: 'user.metadata' }, row(7))).to.eq(false);
  });

  it('never holds for a principal whose account is soft deleted, whatever the lookup returns', async () => {
    class DeletedOwner extends UserMetadataOwnerRelation {
      protected async userOf(): Promise<{ Id?: unknown; DeletedAt?: unknown } | undefined> {
        return { Id: 7, DeletedAt: DateTime.now() };
      }
    }

    expect(await new DeletedOwner().holds(owner, { type: 'user.metadata' }, row(7))).to.eq(false);
  });
});

describe('user.metadata owner relation on the database', function () {
  this.timeout(30000);

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    await bootUsersDb();
  });

  afterEach(() => {
    sinon.restore();
    releaseUsersHost();
  });

  it('holds for the owner of a row while its account exists, never once it is soft deleted', async () => {
    const { user } = await seedUser({ login: 'owner-relation-db' });
    const owner = principal('user', user.Uuid);

    expect(await new UserMetadataOwnerRelation().holds(owner, { type: 'user.metadata' }, row(user.Id))).to.eq(true);

    await setIdentityFlags({ type: 'user', id: user.Uuid }, { deleted: true });

    expect(await new UserMetadataOwnerRelation().holds(owner, { type: 'user.metadata' }, row(user.Id))).to.eq(false);
  });
});
