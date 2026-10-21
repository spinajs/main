import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { createHash, randomUUID } from 'node:crypto';
import { SelectQueryBuilder } from '@spinajs/orm';
import { FakeIdentityStore } from '@spinajs/authn-testing';
import { DateTime } from 'luxon';

import '../../src/generator.js';
import { AccessToken } from '../../src/models/AccessToken.js';
import { DbTokenService } from '../../src/service/index.js';
import { bootV3Db, insertUserRow, shutdownV3Db, v3Connection } from './db.js';
import { tokenServiceOver } from './services.js';

const TABLE = 'rbac_access_tokens';
const NOW = DateTime.fromISO('2026-10-03T10:00:00.000Z') as DateTime<true>;
const PAGE = 500;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('DbTokenService.deleteExpired paging', function () {
  this.timeout(60000);

  let tokens: DbTokenService;
  let rowId: number;

  before(async () => {
    await bootV3Db();
    tokens = await tokenServiceOver({ identities: new FakeIdentityStore() });
    rowId = await insertUserRow(randomUUID());
  });

  after(async () => {
    await shutdownV3Db();
  });

  beforeEach(async () => {
    await v3Connection().del().from(TABLE);
  });

  afterEach(() => {
    sinon.restore();
  });

  async function seed(expired: number, live = 0): Promise<void> {
    const make = (i: number, expiresAt: DateTime<true>) => new AccessToken({ Name: `t${i}`, Token: sha256(`${randomUUID()}${i}`), Roles: [], Kind: 'pat', CreatedAt: NOW, user_id: rowId, ExpiresAt: expiresAt });
    for (let i = 0; i < expired; i++) {
      await make(i, NOW.minus({ days: 1 })).insert();
    }
    for (let i = 0; i < live; i++) {
      await make(expired + i, NOW.plus({ days: 1 })).insert();
    }
  }

  const remaining = async (): Promise<number> => ((await v3Connection().select().from(TABLE)) as unknown[]).length;

  it('never selects more than 500 ids at a time and removes every expired row', async () => {
    await seed(1250, 3);
    const take = sinon.spy(SelectQueryBuilder.prototype, 'take');

    expect(await tokens.deleteExpired(NOW.toJSDate())).to.equal(1250);

    expect(take.callCount).to.be.at.least(3);
    for (const call of take.getCalls()) {
      expect(call.args[0]).to.be.at.most(PAGE);
    }
    expect(await remaining()).to.equal(3);
  });

  it('stops after the last page when the expired rows are an exact multiple of the page size', async () => {
    await seed(PAGE * 2, 1);

    expect(await tokens.deleteExpired(NOW.toJSDate())).to.equal(PAGE * 2);
    expect(await remaining()).to.equal(1);
  });

  it('deletes nothing and answers 0 when no row is due', async () => {
    await seed(0, 4);

    expect(await tokens.deleteExpired(NOW.toJSDate())).to.equal(0);
    expect(await remaining()).to.equal(4);
  });
});
