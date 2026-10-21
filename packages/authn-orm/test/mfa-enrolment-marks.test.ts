import { MfaEnrolmentMarks } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { DbMfaEnrolmentMarks, DbMfaEnrolments, DbMfaStore } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const ALICE: IdentityRef = { type: 'user', id: '0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10' };
const BOB: IdentityRef = { type: 'user', id: '5e0d7f3a-2b44-4d8e-a1c9-6f2e8b3d0c21' };

describe('DbMfaEnrolmentMarks', () => {
  it('is the MfaEnrolmentMarks of the root container once authn-orm is imported', () => {
    expect(DI.RootContainer.getRegisteredTypes(MfaEnrolmentMarks)).to.include(DbMfaEnrolmentMarks);
  });
});

for (const kind of DB_KINDS) {
  describe(`DbMfaEnrolmentMarks over authn_mfa (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let store: DbMfaStore;
    let marks: DbMfaEnrolmentMarks;

    before(async function () {
      db = await bootDb(this, kind, 'mfa_marks');
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authn_mfa', [], QueryContext.Delete);
      store = new DbMfaStore();
      marks = new DbMfaEnrolmentMarks(store);
    });

    it('marks once per identity and step; a second mark answers false', async () => {
      expect(await marks.has(ALICE, 'email-code')).to.eq(false);
      expect(await marks.mark(ALICE, 'email-code')).to.eq(true);
      expect(await marks.has(ALICE, 'email-code')).to.eq(true);
      expect(await marks.mark(ALICE, 'email-code')).to.eq(false);
      expect(await marks.has(BOB, 'email-code')).to.eq(false);
      expect(await marks.has(ALICE, 'totp')).to.eq(false);
    });

    it('unmarks, and the identity can be marked again', async () => {
      await marks.mark(ALICE, 'email-code');
      await marks.unmark(ALICE, 'email-code');
      expect(await marks.has(ALICE, 'email-code')).to.eq(false);
      expect(await marks.mark(ALICE, 'email-code')).to.eq(true);
    });

    it('a mark is a confirmed authn_mfa step, so MfaEnrolments sees it', async () => {
      await marks.mark(ALICE, 'email-code');
      const source = new DbMfaEnrolments(store);
      expect(await source.stepsOf(ALICE)).to.deep.eq(['email-code']);
      expect(await source.stepNames()).to.deep.eq(['email-code']);
      expect(await source.stepsOf(BOB)).to.deep.eq([]);
    });

    it('an unconfirmed row of that step is not a mark, and marking confirms it', async () => {
      await store.putPending(ALICE, 'email-code', 'x', 'none');
      expect(await marks.has(ALICE, 'email-code')).to.eq(false);
      expect(await marks.mark(ALICE, 'email-code')).to.eq(true);
      expect(await marks.has(ALICE, 'email-code')).to.eq(true);
    });

    it('keeps no secret: the row holds a placeholder only', async () => {
      await marks.mark(ALICE, 'email-code');
      const row = await store.get(ALICE, 'email-code');
      expect(row?.confirmedAt).to.not.eq(null);
      expect(row?.keyId).to.eq('none');
    });
  });
}
