import * as chai from 'chai';
import 'mocha';

import { AccessDenied } from '@spinajs/authz';
import { Forbidden } from '@spinajs/exceptions';

import { DIALECTS, PortedWorld, as, ownerRelation, permit, user } from './harness.js';

const expect = chai.expect;

// Ported from users legacy-v2/create-ownership-idor.test.ts (B20, B15): the principal is a real one
// run through the 3.0 ORM middleware, `create:own` is a create permit over the owner relation.
describe('Ownership enforcement on inserts (IDOR regression)', function () {
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

      it('createOwn forces the owner column to the acting user', async () => {
        const Res = await w.resource(dialect);
        await w.grant({ [w.P.create]: permit(ownerRelation), [w.P.read]: permit() });

        await as(attacker, () => Res.insert({ id: 'r1', UserId: attacker.id, Value: 'mine' }));

        expect(await w.stored(Res)).to.deep.equal([[attacker.id, 'mine']]);
      });

      it('createOwn overwrites a forged owner id rather than trusting the payload', async () => {
        const Res = await w.resource(dialect);
        await w.grant({ [w.P.create]: permit(ownerRelation), [w.P.read]: permit() });

        // The attacker hand-sets UserId to the victim so the row would show up under the
        // victim's account. The middleware must overwrite it, not merge with it.
        await as(attacker, () => Res.insert({ id: 'r1', UserId: victim.id, Value: 'forged' }));

        const [[owner, value]] = await w.stored(Res);
        expect(value).to.eq('forged');
        expect(owner).to.eq(attacker.id);
        expect(owner).to.not.eq(victim.id);
      });

      it('createAny leaves the payload alone', async () => {
        const Res = await w.resource(dialect);
        await w.grant({ [w.P.create]: permit(), [w.P.read]: permit() });

        await as(attacker, () => Res.insert({ id: 'r1', UserId: victim.id, Value: 'on-behalf' }));

        expect(await w.stored(Res)).to.deep.equal([[victim.id, 'on-behalf']]);
      });

      it('no create grant is refused', async () => {
        const Res = await w.resource(dialect);
        await w.grant({ [w.P.read]: permit(ownerRelation) });

        // Changed expectation (B01): a 403 AccessDenied, not the 2.x /create permission/ message.
        const e = await as(attacker, () => Res.insert({ id: 'r1', UserId: attacker.id, Value: 'denied' })).then(
          () => undefined,
          (x: unknown) => x,
        );
        expect(e).to.be.instanceOf(AccessDenied).and.instanceOf(Forbidden);
        const decision = (e as AccessDenied).decision;
        expect(decision.permission).to.equal(w.P.create);
        expect(decision.reason?.code).to.equal('no_access');

        expect(await w.stored(Res)).to.deep.equal([]);
      });
    });
  }
});
