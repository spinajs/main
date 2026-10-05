import * as chai from 'chai';
import 'mocha';

import { AccessDenied, or } from '@spinajs/authz';
import type { Principal, ResourceFilter } from '@spinajs/authz';
import type { VoteFn } from '@spinajs/authz-testing';
import { Forbidden } from '@spinajs/exceptions';

import { DIALECTS, PortedWorld, as, ownerRelation, permit, user } from './harness.js';

const expect = chai.expect;

// Ported from users legacy-v2/active-role.test.ts (B24, B07, D14, B20): the 2.x `ActiveRole` of the
// async storage is `ceiling.roles` on the principal. The model below keeps the RBAC rule that matters
// here (B07: `ceiling.roles` removes roles, never adds) so the suite pins what the ORM does with the
// decision; the real RbacModel's ceiling handling runs through the ORM in authz-rbac
// test/ported/active-role-orm.test.ts.
describe('Rbac ActiveRole middleware', function () {
  this.timeout(60000);
  const w = new PortedWorld();

  // admin: read:any, normal: read:own, guest: nothing on this type.
  const GRANTS: Record<string, Record<string, ResourceFilter>> = {
    admin: { [w.P.read]: { op: 'true' } },
    normal: { [w.P.read]: ownerRelation },
    guest: {},
  };
  const assigned: Record<string, readonly string[]> = { 'admin-and-normal': ['admin', 'normal'], 'admin-and-guest': ['admin', 'guest'], 'normal-only': ['normal'] };

  const roleModel: VoteFn = (req) => {
    const held = assigned[req.principal.id] ?? [];
    const ceiling = req.principal.ceiling?.roles;
    const live = ceiling ? held.filter((r) => ceiling.includes(r)) : held;
    const filters = live.flatMap((r) => (GRANTS[r]?.[req.permission] ? [GRANTS[r]![req.permission]!] : []));
    return filters.length > 0 ? permit(or(...filters)) : {};
  };

  /** A user holding `id`'s roles, switched to `active` the way a session does: only a ceiling. */
  const switched = (id: string, active?: string): Principal => ({ ...user(id), ...(active ? { ceiling: { roles: [active] } } : {}) });

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
        await w.grant(roleModel);
        await w.db.insertRaw(Res, { id: 'mine', UserId: 'admin-and-normal', Value: 'mine' });
        await w.db.insertRaw(Res, { id: 'theirs', UserId: 'someone-else', Value: 'theirs' });
        return Res;
      }

      const sqlOf = async (p: Principal, build: () => any) => ((await as(p, () => build().toDB())) as { expression: string; bindings?: unknown[] });
      const valuesOf = async (p: Principal, build: () => any): Promise<string[]> => ((await as(p, () => build())) as { Value: string }[]).map((r) => r.Value).sort();

      it('ActiveRole=admin lets read:any through with no owner filter', async () => {
        const Res = await seed();
        const query = () => Res.where('id', '>', '');
        const p = switched('admin-and-normal', 'admin');

        expect(await valuesOf(p, query)).to.deep.equal(['mine', 'theirs']);
        expect((await sqlOf(p, query)).expression).to.not.match(/UserId/i);
      });

      it('ActiveRole=normal forces read:own owner filter even though user has admin role too', async () => {
        const Res = await seed();
        const query = () => Res.where('id', '>', '');
        const p = switched('admin-and-normal', 'normal');

        const { expression, bindings } = await sqlOf(p, query);
        expect(expression).to.match(/UserId/i);
        expect(bindings).to.include('admin-and-normal');
        expect(await valuesOf(p, query)).to.deep.equal(['mine']);
      });

      it('ActiveRole pointing to a role without any permission throws Forbidden', async () => {
        const Res = await seed();
        // guest has no grant on this type, even though admin (also assigned) has
        const p = switched('admin-and-guest', 'guest');

        let error: unknown;
        try {
          await as(p, () => Res.where('id', '>', ''));
        } catch (e) {
          error = e;
        }
        expect(error).to.be.instanceOf(AccessDenied);
        expect(error).to.be.instanceOf(Forbidden);
        expect((error as AccessDenied).decision.permission).to.equal(w.P.read);
        expect((error as AccessDenied).decision.reason?.code).to.equal('no_access');
      });

      it('Without ActiveRole the full role list is used (admin role wins)', async () => {
        const Res = await seed();
        const query = () => Res.where('id', '>', '');
        const p = switched('admin-and-normal');

        // ActiveRole intentionally omitted: admin's read:any absorbs read:own, so no owner filter
        expect(await valuesOf(p, query)).to.deep.equal(['mine', 'theirs']);
        expect((await sqlOf(p, query)).expression).to.not.match(/UserId/i);
      });

      it('a ceiling naming a role the user does not hold reaches the model and the empty decision is AccessDenied', async () => {
        const Res = await seed();
        const p = switched('normal-only', 'admin');

        let error: unknown;
        try {
          await as(p, () => Res.where('id', '>', ''));
        } catch (e) {
          error = e;
        }
        expect(error).to.be.instanceOf(AccessDenied);
      });
    });
  }
});
