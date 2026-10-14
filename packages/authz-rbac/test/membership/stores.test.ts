import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuthzConfigError, MemoryAuthzAdminBackend } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { AdminMembershipStore, DbMembershipStore, MembershipStore, MemoryMembershipStore } from '../../src/index.js';
import type { MembershipRow } from '../../src/index.js';
import { bootDb, DB_KINDS } from '../support/db.js';
import type { TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const AT = new Date('2026-10-14T12:00:00.000Z');
const LATER = new Date(AT.getTime() + 3_600_000);
const EARLIER = new Date(AT.getTime() - 3_600_000);
const row = (memberKey: string, setKey: string, depth = 1, expiresAt: Date | null = null): MembershipRow => ({ memberKey, setKey, depth, expiresAt });

interface Subject {
  store: AdminMembershipStore;
  inTx<T>(fn: (tx: AuthzTx) => Promise<T>, commit?: boolean): Promise<void>;
}

const ROLLBACK = new Error('rollback');

function contract(name: string, setup: () => Promise<Subject>, teardown: () => Promise<void>) {
  describe(name, function () {
    this.timeout(60000);
    let s: Subject;
    before(async () => {
      s = await setup();
    });
    after(teardown);
    beforeEach(async () => {
      for (const k of await s.store.memberKeys()) await s.inTx((tx) => s.store.replace(k, [], tx));
    });

    it('is a MembershipStore', () => {
      expect(s.store).to.be.instanceOf(MembershipStore);
    });

    it("replace writes a member's rows and drops the old ones", async () => {
      await s.inTx((tx) => s.store.replace('user:u', [row('user:u', 'g:1#m'), row('user:u', 'g:2#m', 2, LATER)], tx));
      await s.inTx((tx) => s.store.replace('user:u', [row('user:u', 'g:2#m', 1)], tx));
      expect(await s.store.rowsOf(['user:u'])).to.deep.equal([row('user:u', 'g:2#m', 1)]);
    });

    it('setsOf and membersOf answer live rows only; rowsOf and allMembersOf keep expired ones', async () => {
      await s.inTx(async (tx) => {
        await s.store.replace('user:u', [row('user:u', 'g:1#m'), row('user:u', 'g:2#m', 1, EARLIER)], tx);
        await s.store.replace('user:v', [row('user:v', 'g:1#m', 2, LATER)], tx);
        await s.store.replace('g:3#m', [row('g:3#m', 'g:1#m')], tx);
      });
      expect(await s.store.setsOf(['user:u', 'user:v'], AT)).to.deep.equal([{ setKey: 'g:1#m' }]);
      expect(await s.store.membersOf('g:1#m', AT)).to.deep.equal(['g:3#m', 'user:u', 'user:v']);
      expect(await s.store.membersOf('g:2#m', AT)).to.deep.equal([]);
      expect(await s.store.allMembersOf(['g:2#m'])).to.deep.equal(['user:u']);
      expect((await s.store.rowsOf(['user:u'])).map((r) => r.setKey).sort()).to.deep.equal(['g:1#m', 'g:2#m']);
      expect(await s.store.memberKeys()).to.deep.equal(['g:3#m', 'user:u', 'user:v']);
      const [v] = await s.store.rowsOf(['user:v']);
      expect(v.expiresAt?.getTime()).to.eq(LATER.getTime());
      expect(v.depth).to.eq(2);
    });

    it('setsOf answers each set once, with the latest expiry of the given members', async () => {
      const LATEST = new Date(LATER.getTime() + 3_600_000);
      await s.inTx(async (tx) => {
        await s.store.replace('user:u', [row('user:u', 'g:5#m', 1, LATER), row('user:u', 'g:6#m', 1, LATER)], tx);
        await s.store.replace('user:v', [row('user:v', 'g:5#m', 1, LATEST), row('user:v', 'g:6#m')], tx);
      });
      const sets = await s.store.setsOf(['user:u', 'user:v'], AT);
      expect(sets.map((x) => [x.setKey, x.expiresAt?.getTime()])).to.deep.equal([
        ['g:5#m', LATEST.getTime()],
        ['g:6#m', undefined],
      ]);
      expect(sets[1]).to.not.have.property('expiresAt');
    });

    it('a rollback undoes replace', async () => {
      await s.inTx((tx) => s.store.replace('user:u', [row('user:u', 'g:1#m')], tx));
      await s.inTx((tx) => s.store.replace('user:u', [], tx), false);
      expect(await s.store.setsOf(['user:u'], AT)).to.deep.equal([{ setKey: 'g:1#m' }]);
    });
  });
}

const memoryBackend = new MemoryAuthzAdminBackend();
contract(
  'MemoryMembershipStore',
  async () => ({
    store: new MemoryMembershipStore(),
    inTx: async (fn, commit = true) => {
      await memoryBackend
        .transaction('test', async (tx) => {
          await fn(tx);
          if (!commit) throw ROLLBACK;
        })
        .catch((e) => {
          if (e !== ROLLBACK) throw e;
        });
    },
  }),
  async () => undefined,
);

for (const kind of DB_KINDS) {
  let db: TestDb | undefined;
  describe(`DbMembershipStore (${kind})`, function () {
    before(async function () {
      db = await bootDb(this, kind, 'membership');
    });
    after(async () => {
      await db?.dispose();
    });

    contract(
      'contract',
      async () => ({
        store: db!.container.resolve(DbMembershipStore),
        inTx: async (fn, commit = true) => {
          await db!.driver
            .transaction(async (driver: OrmDriver) => {
              await fn({ driver });
              if (!commit) throw ROLLBACK;
            })
            .catch((e) => {
              if (e !== ROLLBACK) throw e;
            });
        },
      }),
      async () => undefined,
    );

    it('refuses to write outside a transaction', async () => {
      await expect(db!.container.resolve(DbMembershipStore).replace('user:u', [], { driver: db!.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
    });
  });
}
