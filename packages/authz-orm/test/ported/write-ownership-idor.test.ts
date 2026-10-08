import * as chai from 'chai';
import 'mocha';

import { DIALECTS, PortedWorld, as, ownerRelation, permit, user } from './harness.js';

const expect = chai.expect;

// Ported from users legacy-v2/write-ownership-idor.test.ts (B20, B15): `update:own` and `delete:own`
// are permits over the owner relation, which the middleware ANDs around the caller's own where.
describe('Ownership enforcement on write queries (IDOR regression)', function () {
  this.timeout(60000);
  const w = new PortedWorld();
  const attacker = user('attacker-id');
  const victim = user('victim-id');

  before(() => w.open());
  after(() => w.close());
  afterEach(() => w.reset());

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !w.pg) this.skip();
      });

      async function seed() {
        const Res = await w.resource(dialect);
        await w.grant({ [w.P.update]: permit(ownerRelation), [w.P.delete]: permit(ownerRelation), [w.P.read]: permit(ownerRelation) });
        await w.db.insertRaw(Res, { id: 'attacker-row', UserId: attacker.id, Value: 'attacker' });
        await w.db.insertRaw(Res, { id: 'victim-row', UserId: victim.id, Value: 'victim' });
        return Res;
      }

      it("UPDATE with :own scope cannot touch another user's row via an OR lookup", async () => {
        const Res = await seed();

        await as(attacker, () =>
          Res.update({ Value: 'hacked' }).where(function (this: any) {
            this.where('id', 'attacker-row').orWhere('id', 'victim-row');
          }),
        );

        expect(await w.stored(Res)).to.deep.equal([
          [attacker.id, 'hacked'],
          [victim.id, 'victim'],
        ]);
      });

      it("DELETE with :own scope cannot delete another user's row in a multi-key destroy", async () => {
        const Res = await seed();

        // The attacker asks for both rows by key. `destroy()` refuses an unbounded DELETE, so
        // this is the real attack shape: a bounded key set that reaches beyond the caller. The
        // ownership middleware has to AND its owner constraint onto it.
        await as(attacker, () => Res.destroy(['attacker-row', 'victim-row']));

        expect(await w.stored(Res)).to.deep.equal([[victim.id, 'victim']]);
      });
    });
  }
});
