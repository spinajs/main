import type { IdentityRef } from '@spinajs/authn/contracts';
import { MfaEnrolments } from '@spinajs/authn/mfa-enrolments';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { DbMfaEnrolments, DbMfaStore } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const ALICE: IdentityRef = { type: 'user', id: '0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10' };
const BOB: IdentityRef = { type: 'user', id: '5e0d7f3a-2b44-4d8e-a1c9-6f2e8b3d0c21' };
const CIPHER = 'v1.AAECAwQFBgcICQoL.DA0ODxAREhMUFRYXGBkaGw.HB0eHyAhIiMkJSYn';

const SOURCE = MfaEnrolments as unknown as Class<MfaEnrolments>;

describe('DbMfaEnrolments', () => {
  it('is an MfaEnrolments source of the root container once authn-orm is imported', () => {
    expect(DI.RootContainer.getRegisteredTypes(Array.chainOf(SOURCE))).to.include(DbMfaEnrolments);
  });

  it('resolves through the chain DefaultMfaPolicy asks, from a child container', async () => {
    const child = DI.child();
    try {
      const sources = (await child.resolve(Array.chainOf(SOURCE))) as MfaEnrolments[];
      expect(sources.filter((s) => s instanceof DbMfaEnrolments)).to.have.length(1);
    } finally {
      await child.dispose();
    }
  });
});

for (const kind of DB_KINDS) {
  describe(`DbMfaEnrolments over authn_mfa (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let store: DbMfaStore;
    let source: DbMfaEnrolments;

    before(async function () {
      db = await bootDb(this, kind, 'mfa_enrolments');
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authn_mfa', [], QueryContext.Delete);
      store = new DbMfaStore(db.driver);
      source = new DbMfaEnrolments(store);
    });

    it('reports the confirmed steps of an identity and of the store; an unconfirmed row does not count', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      await store.put(BOB, 'totp', CIPHER, 'kid-a');
      expect(await source.stepsOf(ALICE)).to.deep.eq([]);
      expect(await source.stepNames()).to.deep.eq([]);

      await store.confirm(ALICE, 'totp');
      expect(await source.stepsOf(ALICE)).to.deep.eq(['totp']);
      expect(await source.stepsOf(BOB)).to.deep.eq([]);
      expect(await source.stepNames()).to.deep.eq(['totp']);
    });
  });
}
