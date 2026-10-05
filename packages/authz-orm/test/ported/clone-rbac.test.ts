import * as chai from 'chai';
import 'mocha';

import type { Principal, ResourceFilter } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { BelongsTo, ModelBase } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { AccessResource, Owner, OrmScope, OrmScopePolicy } from '../../src/index.js';
import type { Dialect } from '../support/db.js';
import { DIALECTS, PortedWorld, as, ownerRelation, permit, user } from './harness.js';

const expect = chai.expect;

type Static = typeof ModelBase & { select(): any };

const via: ResourceFilter = { op: 'relation', relation: 'viaOwner' };

/**
 * Ported from users legacy-v2/clone-rbac.test.ts (B20, B21): a cloned query is constrained exactly as
 * the query it was cloned from. Paginated endpoints take the constrained query, clone it for the row
 * count and populate the original; a clone that lost the constraint would count the whole table and
 * disclose how many rows exist outside the caller's scope.
 *
 * The 2.x fixture constrained with a correlated `whereExist` rather than a plain column test, the shape
 * that used to vanish from a clone. It is the `viaOwner` @OrmScope policy here; every case also runs
 * against the plain @Owner column residual.
 */
describe('rbac constraints survive query cloning', function () {
  this.timeout(60000);
  const w = new PortedWorld();
  const caller = user('42');
  const policies: (abstract new () => unknown)[] = [];

  before(() => w.open());
  after(() => w.close());
  afterEach(async () => {
    await w.reset();
    for (const p of policies.splice(0)) DI.uncache(p as never);
  });

  // DI keys classes by name, so a same-named policy of a later case would resolve to this one.
  let seq = 0;
  function viaOwnerPolicy(): abstract new () => OrmScopePolicy {
    class ViaOwnerPolicy extends OrmScopePolicy {
      scope(q: IWhereBuilder<ModelBase>, principal: Principal): void {
        q.whereExist('Owner', function (this: IWhereBuilder<ModelBase>) {
          this.where('id', '=', principal.id);
        });
      }
    }
    Object.defineProperty(ViaOwnerPolicy, 'name', { value: `ViaOwnerPolicy_${++seq}` });
    policies.push(ViaOwnerPolicy);
    return ViaOwnerPolicy;
  }

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !w.pg) this.skip();
      });

      /**
       * Seeded unscoped (raw inserts): three rows owned by the caller, four owned by somebody else.
       */
      async function seed(dialect: Dialect) {
        const Account = (await w.db.define({ name: 'Account', columns: { Name: 'TEXT' } }, dialect)) as Static;
        const Res = (await w.db.define(
          {
            name: 'CloneRbac',
            columns: { user_id: 'TEXT', Value: 'TEXT' },
            decorate: (cls, proto) => {
              AccessResource(w.TYPE)(cls);
              Owner()(proto, 'user_id');
              OrmScope(cls as never, 'viaOwner')(viaOwnerPolicy() as never);
              BelongsTo(Account as never, 'user_id', 'id')(proto, 'Owner');
            },
          },
          dialect,
        )) as Static;
        (w.db.orm as unknown as { wireRelations(): void }).wireRelations();

        await w.db.insertRaw(Account, { id: caller.id, Name: 'caller' });
        await w.db.insertRaw(Account, { id: '1041', Name: 'other' });
        for (const Value of ['a', 'b', 'c']) await w.db.insertRaw(Res, { id: `own-${Value}`, user_id: caller.id, Value });
        for (const Value of ['d', 'e', 'f', 'g']) await w.db.insertRaw(Res, { id: `foreign-${Value}`, user_id: '1041', Value });

        return { Res, owned: 3, total: 7 };
      }

      /** The exact shape a paginated controller uses: clone for the count, then populate the rows. */
      async function listAndCount(Res: Static, narrow?: (q: any) => any) {
        const query = narrow ? narrow(Res.select()) : Res.select();
        const countQuery = query.clone();

        const rows = (await query.populate('Owner')) as unknown[];
        const count = Number(await countQuery.selectCount());

        return { rows, count };
      }

      for (const [shape, readOwn] of [
        ['correlated whereExist policy', via],
        ['@Owner column', ownerRelation],
      ] as const) {
        describe(shape, () => {
          it('a readOwn caller gets a count that matches the rows it is allowed to see', async () => {
            const { Res, owned } = await seed(dialect);
            await w.grant({ [w.P.read]: permit(readOwn) });

            const { rows, count } = await as(caller, () => listAndCount(Res));

            expect(rows).to.be.an('array').with.length(owned);
            expect(count).to.eq(owned);
          });

          it('a readAny caller still counts everything', async () => {
            const { Res, total } = await seed(dialect);
            await w.grant({ [w.P.read]: permit() });

            const { rows, count } = await as(caller, () => listAndCount(Res));

            expect(rows).to.be.an('array').with.length(total);
            expect(count).to.eq(total);
          });

          it('the clone is constrained even when it is compiled before the original', async () => {
            const { Res, owned } = await seed(dialect);
            await w.grant({ [w.P.read]: permit(readOwn) });

            const result = await as(caller, async () => {
              const query = Res.select();
              const countQuery = query.clone();

              // count first this time: the constraint must not depend on which query compiles first
              const count = Number(await countQuery.selectCount());
              const rows = (await query.populate('Owner')) as unknown[];

              return { count, rows };
            });

            expect(result.rows).to.be.an('array').with.length(owned);
            expect(result.count).to.eq(owned);
          });

          it('a clone of a clone stays constrained', async () => {
            const { Res, owned } = await seed(dialect);
            await w.grant({ [w.P.read]: permit(readOwn) });

            const count = await as(caller, async () => Number(await Res.select().clone().clone().selectCount()));

            expect(count).to.eq(owned);
          });

          it('a caller-supplied filter narrows both the rows and the count', async () => {
            const { Res } = await seed(dialect);
            await w.grant({ [w.P.read]: permit(readOwn) });

            const result = await as(caller, () => listAndCount(Res, (q) => q.where('Value', 'a')));

            expect(result.rows).to.be.an('array').with.length(1);
            expect(result.count).to.eq(1);
          });
        });
      }
    });
  }
});
