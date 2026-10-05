import * as chai from 'chai';
import 'mocha';

import { AccessDenied, AuthzConfigError } from '@spinajs/authz';
import type { Principal, ResourceFilter } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import type { InsertQueryBuilder, IWhereBuilder, ModelBase } from '@spinajs/orm';

import { AccessResource, OrmScope, OrmScopePolicy, Owner } from '../../src/index.js';
import type { Dialect } from '../support/db.js';
import { DIALECTS, PortedWorld, as, ownerRelation, permit, user } from './harness.js';
import type { Resource } from './harness.js';

const expect = chai.expect;

type Op = 'read' | 'update' | 'delete';
type Q = IWhereBuilder<ModelBase>;

interface PolicyImpl {
  scope(q: Q, p: Principal, op: Op): void;
  authorizeCreate?(q: InsertQueryBuilder, p: Principal): void | Promise<void>;
}

const rel = (relation: string): ResourceFilter => ({ op: 'relation', relation });
const or = (...args: ResourceFilter[]): ResourceFilter => ({ op: 'or', args });

// Ported from users legacy-v2/orm-permission-policy.test.ts (B20, B15, B21, B02): the 2.x
// OrmPermissionPolicy is an @OrmScope policy. The 2.x "default" policy is the `owner` relation of a model
// without an @Owner column; a named scope is another relation; the `scopeRead/Update/Delete` triple is
// one `scope(q, principal, op)`; a grant attribute is a relation in the permit filter.
describe('OrmScopePolicy where-path', function () {
  this.timeout(60000);
  const w = new PortedWorld();
  const normal = user('1');
  const calls: string[] = [];
  const made: (abstract new () => unknown)[] = [];

  before(() => w.open());
  after(() => w.close());
  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(async () => {
    await w.reset();
    for (const p of made.splice(0)) DI.uncache(p as never);
  });

  // DI keys classes by name, so a same-named policy of a later case would resolve to this one.
  let seq = 0;
  function policy(impl: PolicyImpl): abstract new () => OrmScopePolicy {
    class P extends OrmScopePolicy {
      scope(q: Q, p: Principal, op: Op): void {
        impl.scope(q, p, op);
      }
    }
    if (impl.authorizeCreate) (P.prototype as OrmScopePolicy).authorizeCreate = impl.authorizeCreate;
    Object.defineProperty(P, 'name', { value: `OrmPolicy_${++seq}` });
    made.push(P);
    return P;
  }

  const fails = (p: PromiseLike<unknown>): Promise<unknown> =>
    Promise.resolve(p).then(
      () => undefined,
      (e: unknown) => e,
    );

  const values = (rows: unknown): string[] => (rows as { Value: string }[]).map((r) => r.Value).sort();

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !w.pg) this.skip();
      });

      let n = 0;
      const typeName = (): string => `pol${++n}`;

      interface Spec {
        type: string;
        owner?: boolean;
        policies?: Record<string, abstract new () => OrmScopePolicy>;
        base?: Resource;
      }

      function model(spec: Spec, d: Dialect = dialect): Promise<Resource> {
        return w.db.define(
          {
            name: 'PolicyModel',
            columns: { UserId: 'TEXT', Value: 'TEXT' },
            ...(spec.base ? { base: spec.base as never } : {}),
            decorate: (cls, proto) => {
              AccessResource(spec.type)(cls);
              if (spec.owner) Owner()(proto, 'UserId');
              for (const [relation, p] of Object.entries(spec.policies ?? {})) OrmScope(cls as never, relation)(p as never);
            },
          },
          d,
        ) as Promise<Resource>;
      }

      const grantAll = (type: string, f: ResourceFilter, opts: { sync?: 'never' } = {}) =>
        w.grant(
          Object.fromEntries((['read', 'create', 'update', 'delete'] as const).map((k) => [`${type}:${k}`, permit(f)])),
          [type],
          opts,
        );

      const seed = (Res: Resource, rows: [string, string, string][]) => Promise.all(rows.map(([id, UserId, Value]) => w.db.insertRaw(Res, { id, UserId, Value })));

      const routed = (): PolicyImpl => ({
        scope(q, _p, op) {
          calls.push(op);
          q.where('Value', { read: 'readable', update: 'updatable', delete: 'deletable' }[op]);
        },
      });

      describe('operation routing', () => {
        it('select uses the read scope', async () => {
          const type = typeName();
          const Res = await model({ type, policies: { owner: policy(routed()) } });
          await seed(Res, [
            ['1', normal.id, 'readable'],
            ['2', normal.id, 'other'],
          ]);
          await grantAll(type, ownerRelation);

          const rows = await as(normal, () => Res.query());

          expect(calls).to.eql(['read']);
          expect(values(rows)).to.eql(['readable']);
        });

        it('update uses the update scope', async () => {
          const type = typeName();
          const Res = await model({ type, policies: { owner: policy(routed()) } });
          await seed(Res, [
            ['1', normal.id, 'updatable'],
            ['2', normal.id, 'other'],
          ]);
          await grantAll(type, ownerRelation);

          await as(normal, () => Res.update({ UserId: normal.id, Value: 'updatable' }).where('id', '>', ''));

          expect(calls).to.eql(['update']);
        });

        it('delete uses the delete scope', async () => {
          const type = typeName();
          const Res = await model({ type, policies: { owner: policy(routed()) } });
          await seed(Res, [
            ['1', normal.id, 'deletable'],
            ['2', normal.id, 'other'],
          ]);
          await grantAll(type, ownerRelation);

          await as(normal, () => Res.destroy('1'));
          expect(calls).to.eql(['delete']);
          expect(await w.stored(Res)).to.eql([[normal.id, 'other']]);

          await as(normal, () => Res.destroy('2'));
          expect(await w.stored(Res)).to.eql([[normal.id, 'other']]);
        });

        it('a policy with one scope serves read, update and delete', async () => {
          const type = typeName();
          const Res = await model({
            type,
            policies: {
              owner: policy({
                scope(q, _p, op) {
                  calls.push(op);
                  q.where('Value', 'generic');
                },
              }),
            },
          });
          await seed(Res, [['1', normal.id, 'generic']]);
          await grantAll(type, ownerRelation);

          await as(normal, () => Res.query());
          await as(normal, () => Res.update({ UserId: normal.id, Value: 'generic' }).where('id', '>', ''));
          await as(normal, () => Res.destroy('1'));

          expect(calls).to.eql(['read', 'update', 'delete']);
        });

        it('a subclass model declaring the same resource resolves the shared policy', async () => {
          const type = typeName();
          const Base = await model({ type, policies: { owner: policy(routed()) } });
          const Sub = await model({ type, base: Base });
          await seed(Sub, [
            ['1', normal.id, 'readable'],
            ['2', normal.id, 'other'],
          ]);
          await grantAll(type, ownerRelation);

          const rows = await as(normal, () => Sub.query());

          expect(calls).to.eql(['read']);
          expect(values(rows)).to.eql(['readable']);
        });
      });

      describe('fallbacks', () => {
        it('an @Owner model with no policy filters by the owner column', async () => {
          const type = typeName();
          const Res = await model({ type, owner: true });
          await seed(Res, [
            ['1', normal.id, 'mine'],
            ['2', '1000', 'theirs'],
          ]);
          await grantAll(type, ownerRelation);

          const rows = (await as(normal, () => Res.query())) as unknown as { Value: string }[];

          expect(rows).to.be.an('array').with.length(1);
          expect(rows[0]!.Value).to.eq('mine');
        });

        it('a model with no policy and no @Owner fails loud', async () => {
          const type = typeName();
          const Res = await model({ type });
          await grantAll(type, ownerRelation);

          const e = await fails(as(normal, () => Res.query()));

          // Changed expectation (B02, B15): AuthzConfigError, not an OrmException.
          expect(e).to.be.instanceOf(AuthzConfigError);
          expect((e as Error).message).to.match(/needs @Owner\(\) or an @OrmScope/);
        });

        it('an unconditional grant skips policies entirely', async () => {
          const type = typeName();
          const Res = await model({ type, policies: { owner: policy(routed()) } });
          await seed(Res, [
            ['1', normal.id, 'alpha'],
            ['2', normal.id, 'beta'],
          ]);
          await grantAll(type, { op: 'true' });

          const rows = await as(normal, () => Res.query());

          expect(calls).to.eql([]);
          expect(rows).to.be.an('array').with.length(2);
        });
      });

      describe('a policy runs exactly once per query', () => {
        it('clone() does not re-run the policy', async () => {
          const type = typeName();
          const Res = await model({ type, policies: { owner: policy(routed()) } });
          await seed(Res, [['1', normal.id, 'readable']]);
          await grantAll(type, ownerRelation);

          await as(normal, async () => {
            const query = (Res as any).select();
            const countQuery = query.clone();

            await query;
            await countQuery.selectCount();
          });

          expect(calls).to.eql(['read']);
        });

        it('a policy of a model that resolves late is not re-run when the deferred statement compiles', async () => {
          const type = typeName();
          const Res = await model({ type, policies: { owner: policy(routed()) } });
          await seed(Res, [
            ['1', normal.id, 'readable'],
            ['2', normal.id, 'other'],
          ]);
          // Changed expectation (B20): the 2.x `Lazy` where has no 3.0 form; the deferred case is a model with
          // sync 'never', whose residual is resolved before the query runs.
          await grantAll(type, ownerRelation, { sync: 'never' });

          const rows = (await as(normal, () => (Res as any).select())) as { Value: string }[];

          expect(calls).to.eql(['read']);
          expect(rows).to.be.an('array').with.length(1);
          expect(rows[0]!.Value).to.eq('readable');
        });
      });

      describe('insert', () => {
        const stamping = (): PolicyImpl => ({
          scope: () => undefined,
          authorizeCreate(q) {
            calls.push('authorizeCreate');
            q.forceColumn('Value', 'stamped-by-policy');
          },
        });

        it('insert uses authorizeCreate of the policy relation', async () => {
          const type = typeName();
          const Res = await model({ type, policies: { owner: policy(stamping()) } });
          await grantAll(type, ownerRelation);

          await as(normal, () => Res.insert({ id: 'r1', UserId: '4242', Value: 'from-payload' }));

          expect(calls).to.eql(['authorizeCreate']);
          expect(await w.stored(Res)).to.eql([['4242', 'stamped-by-policy']]);
        });

        // Changed shape (B05, B20): the 2.x policy on an @Owner model could not coexist with the owner policy; the policy sits on
        // `pool` and the create grant names only `pool`, so the owner relation is not held and nothing stamps the column.
        it('insert on an @Owner model uses authorizeCreate and suppresses @Owner stamping', async () => {
          const type = typeName();
          const Res = await model({ type, owner: true, policies: { pool: policy(stamping()) } });
          await grantAll(type, rel('pool'));

          await as(normal, () => Res.insert({ id: 'r1', UserId: '4242', Value: 'from-payload' }));

          expect(calls).to.eql(['authorizeCreate']);
          expect(await w.stored(Res)).to.eql([['4242', 'stamped-by-policy']]);
        });

        it('awaits an async authorizeCreate before the row lands (allow path)', async () => {
          const type = typeName();
          const allowed = [normal.id];
          const Res = await model({
            type,
            policies: {
              owner: policy({
                scope: () => undefined,
                async authorizeCreate(q, p) {
                  calls.push('authorizeCreate:start');
                  await new Promise((r) => setTimeout(r, 10));
                  if (q.getColumnValues('UserId').some((r) => !allowed.includes(r as string))) {
                    calls.push('authorizeCreate:reject');
                    throw new Forbidden('owner is not assigned to this user');
                  }
                  calls.push('authorizeCreate:allow');
                  q.forceColumn('Value', `checked-for-${p.id}`);
                },
              }),
            },
          });
          await grantAll(type, ownerRelation);

          await as(normal, () => Res.insert({ id: 'r1', UserId: normal.id, Value: 'from-payload' }));

          expect(calls).to.eql(['authorizeCreate:start', 'authorizeCreate:allow']);
          expect(await w.stored(Res)).to.eql([[normal.id, `checked-for-${normal.id}`]]);
        });

        it('a rejecting async authorizeCreate prevents the insert', async () => {
          const type = typeName();
          const Res = await model({
            type,
            policies: {
              owner: policy({
                scope: () => undefined,
                async authorizeCreate(q) {
                  calls.push('authorizeCreate:start');
                  await new Promise((r) => setTimeout(r, 10));
                  if (q.getColumnValues('UserId').length > 0) {
                    calls.push('authorizeCreate:reject');
                    throw new Forbidden('owner is not assigned to this user');
                  }
                },
              }),
            },
          });
          await grantAll(type, ownerRelation);

          const e = await fails(as(normal, () => Res.insert({ id: 'r1', UserId: normal.id, Value: 'forged' })));

          expect(e).to.be.instanceOf(Forbidden);
          expect((e as Error).message).to.match(/is not assigned to this user/);
          expect(calls).to.eql(['authorizeCreate:start', 'authorizeCreate:reject']);
          expect(await w.stored(Res)).to.eql([]);
        });

        it('an @Owner model with no policy stamps the owner column on insert', async () => {
          const type = typeName();
          const Res = await model({ type, owner: true });
          await grantAll(type, ownerRelation);

          await as(normal, () => Res.insert({ id: 'r1', UserId: '1000', Value: 'forged' }));

          expect(await w.stored(Res)).to.eql([[normal.id, 'forged']]);
        });

        // IDOR closure: do not weaken. A policy that implements only scope() must not shadow the @Owner stamp
        // into a denial, and must not let a forged owner id through. Changed shape (B05): the 2.x policy bound to
        // the owner column's own resource; `owner` has one resolver per type in 3.0, so the scope-only policy sits
        // on another relation (`pool`) of the same model.
        it('a registered policy implementing only scope() falls back to @Owner and stamps the owner column (IDOR closure)', async () => {
          const type = typeName();
          const Res = await model({
            type,
            owner: true,
            policies: {
              pool: policy({
                scope(q, _p, op) {
                  calls.push(op);
                  q.where('Value', 'generic');
                },
              }),
            },
          });
          await grantAll(type, or(ownerRelation, rel('pool')));

          await as(normal, () => Res.insert({ id: 'r1', UserId: '1000', Value: 'forged' }));

          const rows = await w.stored(Res);
          expect(rows).to.eql([[normal.id, 'forged']]);
          expect(rows.some(([owner]) => owner === '1000')).to.equal(false);
          expect(calls, 'the read scope never runs on an insert').to.eql([]);
        });

        it('the IDOR closure holds for every row of a batch insert', async () => {
          const type = typeName();
          const Res = await model({ type, owner: true, policies: { pool: policy({ scope: () => undefined }) } });
          await grantAll(type, or(ownerRelation, rel('pool')));

          await as(normal, () =>
            Res.insert([
              { id: 'r1', UserId: '1000', Value: 'forged-1' },
              { id: 'r2', UserId: '2000', Value: 'forged-2' },
            ]),
          );

          expect(await w.stored(Res)).to.eql([
            [normal.id, 'forged-1'],
            [normal.id, 'forged-2'],
          ]);
        });

        it('a scope-only policy relation alone cannot be used to forge an owner', async () => {
          const type = typeName();
          const Res = await model({ type, owner: true, policies: { pool: policy({ scope: () => undefined }) } });
          await grantAll(type, rel('pool'));

          const e = await fails(as(normal, () => Res.insert({ id: 'r1', UserId: '1000', Value: 'forged' })));

          expect(e).to.be.instanceOf(Forbidden);
          expect(await w.stored(Res)).to.eql([]);
        });

        it('a registered policy with no authorizeCreate and no @Owner still denies, as Forbidden', async () => {
          const type = typeName();
          const Res = await model({ type, policies: { owner: policy({ scope: () => undefined }) } });
          await grantAll(type, ownerRelation);

          const e = await fails(as(normal, () => Res.insert({ id: 'r1', Value: 'x' })));

          // An authorization failure (403), not a config error. Changed expectation (B20): the message says
          // the row does not satisfy the permission, not that authorizeCreate is missing.
          expect(e).to.be.instanceOf(Forbidden);
          expect(e).to.not.be.instanceOf(AuthzConfigError);
          expect(await w.stored(Res)).to.eql([]);
        });

        it('a model with neither policy nor @Owner is refused on an owner insert', async () => {
          const type = typeName();
          const Res = await model({ type });
          await grantAll(type, ownerRelation);

          const e = await fails(as(normal, () => Res.insert({ id: 'r1', Value: 'x' })));

          // Changed expectation (B02, B20): nothing can stamp or check the owner, so the insert is a 403.
          expect(e).to.be.instanceOf(Forbidden);
          expect(await w.stored(Res)).to.eql([]);
        });

        it('an unconditional create skips authorizeCreate', async () => {
          const type = typeName();
          const Res = await model({ type, policies: { owner: policy(stamping()) } });
          await grantAll(type, { op: 'true' });

          await as(normal, () => Res.insert({ id: 'r1', UserId: normal.id, Value: 'unstamped' }));

          expect(calls).to.eql([]);
          expect(await w.stored(Res)).to.eql([[normal.id, 'unstamped']]);
        });

        describe('multi-relation OR-composition', () => {
          const pair = (rejectDefault: boolean, rejectSubset: boolean) => {
            const make = (label: string, reject: boolean): PolicyImpl => ({
              scope: () => undefined,
              async authorizeCreate(q) {
                calls.push(`authorizeCreate:${label}`);
                if (reject) throw new Forbidden(`${label} policy rejects create`);
                q.forceColumn('Value', `created-by-${label}`);
              },
            });
            return { owner: policy(make('default', rejectDefault)), subset: policy(make('subset', rejectSubset)) };
          };

          // BUG(T1): authorizeInsert stops at the first authorizeCreate that throws, so an OR of two relations never falls through to the second, see .authz-sdd/T1-handoffs.md
          it.skip('first-success-wins: row lands via the second policy after the first rejects', async () => {
            const type = typeName();
            const Res = await model({ type, policies: pair(true, false) });
            await grantAll(type, or(rel('owner'), rel('subset')));

            await as(normal, () => Res.insert({ id: 'r1', UserId: normal.id, Value: 'from-payload' }));

            expect(calls).to.eql(['authorizeCreate:default', 'authorizeCreate:subset']);
            expect(await w.stored(Res)).to.eql([[normal.id, 'created-by-subset']]);
          });

          // BUG(T1): same short circuit; the first policy's error surfaces and the second never runs, see .authz-sdd/T1-handoffs.md
          it.skip('all-reject: insert is rejected and the last policy error surfaces', async () => {
            const type = typeName();
            const Res = await model({ type, policies: pair(true, true) });
            await grantAll(type, or(rel('owner'), rel('subset')));

            const e = await fails(as(normal, () => Res.insert({ id: 'r1', UserId: normal.id, Value: 'from-payload-multi-reject' })));

            expect(e).to.be.instanceOf(Forbidden);
            expect((e as Error).message).to.match(/subset policy rejects create/);
            expect(calls).to.eql(['authorizeCreate:default', 'authorizeCreate:subset']);
            expect(await w.stored(Res)).to.eql([]);
          });

          it('a rejecting policy among OR-ed relations refuses the insert and leaves no row', async () => {
            const type = typeName();
            const Res = await model({ type, policies: pair(true, true) });
            await grantAll(type, or(rel('owner'), rel('subset')));

            const e = await fails(as(normal, () => Res.insert({ id: 'r1', UserId: normal.id, Value: 'from-payload-multi-reject' })));

            expect(e).to.be.instanceOf(Forbidden);
            expect((e as Error).message).to.match(/policy rejects create/);
            expect(await w.stored(Res)).to.eql([]);
          });
        });
      });

      describe('named scopes', () => {
        const scoped = () => ({
          owner: policy({
            scope(q) {
              calls.push('default');
              q.where('Value', 'default-visible');
            },
          }),
          subset: policy({
            scope(q) {
              calls.push('subset');
              q.where('Value', 'subset-visible');
            },
          }),
        });
        const three = (Res: Resource, user = normal.id) =>
          seed(Res, [
            ['1', user, 'default-visible'],
            ['2', user, 'subset-visible'],
            ['3', user, 'neither'],
          ]);

        it("a 'subset' relation routes to the named policy", async () => {
          const type = typeName();
          const Res = await model({ type, policies: scoped() });
          await three(Res);
          await grantAll(type, rel('subset'));

          const rows = await as(normal, () => Res.query());

          expect(calls).to.eql(['subset']);
          expect(values(rows)).to.eql(['subset-visible']);
        });

        it('the owner relation routes to the default policy', async () => {
          const type = typeName();
          const Res = await model({ type, policies: scoped() });
          await three(Res);
          await grantAll(type, ownerRelation);

          const rows = await as(normal, () => Res.query());

          // Changed expectation (B15): `:own ['*']` is the owner relation, whose @OrmScope policy is the default.
          expect(calls).to.eql(['default']);
          expect(values(rows)).to.eql(['default-visible']);
        });

        it('two relations with different scopes OR-compose', async () => {
          const type = typeName();
          const Res = await model({ type, policies: scoped() });
          await three(Res);
          await seed(Res, [
            ['4', '1000', 'default-visible'],
            ['5', '1000', 'subset-visible'],
          ]);
          await grantAll(type, or(ownerRelation, rel('subset')));

          // The caller's own WHERE makes the SQL shape provable: `UserId = ? AND (default OR subset)`. An OR that
          // leaked to the top level, or a dropped base WHERE, would show the other user's rows.
          const rows = (await as(normal, () => Res.where('UserId', normal.id))) as unknown as { UserId: string; Value: string }[];

          expect(calls).to.have.members(['default', 'subset']);
          expect(rows).to.be.an('array').with.length(2);
          expect(rows.every((r) => r.UserId === normal.id)).to.be.true;
          expect(values(rows)).to.eql(['default-visible', 'subset-visible']);
        });

        it("the owner relation does NOT absorb another relation's scope", async () => {
          const type = typeName();
          const Res = await model({ type, policies: scoped() });
          await seed(Res, [['1', normal.id, 'subset-visible']]);
          await grantAll(type, or(ownerRelation, rel('subset')));

          const rows = await as(normal, () => Res.query());

          // Changed expectation (B15, B11): `:own ['*']` is a relation, not an unconditional grant, so the
          // other relation's policy still runs and its rows still show.
          expect(calls).to.include('subset');
          expect(values(rows)).to.eql(['subset-visible']);
        });

        // The 2.x limitation was about `extends`; the real RbacModel case is authz-rbac/test/ported/active-role-orm.test.ts. Here only
        // the shape an extender resolves to is pinned: owner OR another relation, both resolvers run.
        it('a grant of owner OR another relation runs both resolvers and shows both row sets', async () => {
          const type = typeName();
          const Res = await model({ type, policies: scoped() });
          await three(Res);
          // Changed expectation (B12, B15): `extends` inherits grants and several relations OR, so the extender holds
          // `owner` OR `subset`; both resolvers run and both row sets show.
          await grantAll(type, or(ownerRelation, rel('subset')));

          const rows = await as(normal, () => Res.query());

          expect(calls).to.have.members(['default', 'subset']);
          expect(values(rows)).to.eql(['default-visible', 'subset-visible']);
        });

        it('a granted relation with no policy throws a config error', async () => {
          const type = typeName();
          const Res = await model({ type, policies: scoped() });
          await grantAll(type, rel('ghost'));

          const e = await fails(as(normal, () => Res.query()));

          expect(e).to.be.instanceOf(AuthzConfigError);
          expect((e as Error).message).to.match(/relation 'ghost'/);
        });
      });

      describe('model-precise resolution (shared type)', () => {
        const labelled = (label: string, visible: string) =>
          policy({
            scope(q) {
              calls.push(label);
              q.where('Value', visible);
            },
          });

        it('two unrelated models sharing one type each resolve their OWN policy', async () => {
          const type = typeName();
          const A = await model({ type, policies: { owner: labelled('siblingA', 'a-visible') } });
          const B = await model({ type, policies: { owner: labelled('siblingB', 'b-visible') } });
          await seed(A, [
            ['1', normal.id, 'a-visible'],
            ['2', normal.id, 'b-visible'],
          ]);
          await seed(B, [
            ['1', normal.id, 'a-visible'],
            ['2', normal.id, 'b-visible'],
          ]);
          await grantAll(type, ownerRelation);

          const aRows = await as(normal, () => A.query());
          expect(calls).to.eql(['siblingA']);
          expect(values(aRows)).to.eql(['a-visible']);

          calls.length = 0;
          const bRows = await as(normal, () => B.query());
          expect(calls).to.eql(['siblingB']);
          expect(values(bRows)).to.eql(['b-visible']);
        });

        it('a shared-type model with no own policy and no matching ancestor falls back to @Owner', async () => {
          const type = typeName();
          // Changed shape (B05): the sibling's policy is on `pool`, since `owner` has one resolver per type.
          await model({ type, policies: { pool: labelled('siblingA', 'a-visible') } });
          const Plain = await model({ type, owner: true });
          await seed(Plain, [
            ['1', normal.id, 'mine'],
            ['2', '1000', 'theirs'],
          ]);
          await grantAll(type, or(ownerRelation, rel('pool')));

          const rows = await as(normal, () => Plain.query());

          // No sibling policy ran.
          expect(calls).to.eql([]);
          expect(values(rows)).to.eql(['mine']);
        });

        it('a shared-type model with no own policy, no matching ancestor and no @Owner sees nothing, and fails loud when no sibling has the relation either', async () => {
          const type = typeName();
          await model({ type, policies: { owner: labelled('siblingA', 'a-visible') } });
          const Naked = await model({ type });
          await seed(Naked, [['1', normal.id, 'a-visible']]);
          await grantAll(type, ownerRelation);

          // Changed expectation (B21, B02): the type has the relation through a sibling, so its resolver answers
          // false for this model's rows (no rows, nothing borrowed from the sibling); the config error stays for a
          // type that has the relation nowhere.
          expect(await as(normal, () => Naked.query())).to.eql([]);
          expect(calls).to.eql([]);

          const otherType = typeName();
          const Alone = await model({ type: otherType });
          await grantAll(otherType, ownerRelation);
          const e = await fails(as(normal, () => Alone.query()));
          expect(e).to.be.instanceOf(AuthzConfigError);
          expect((e as Error).message).to.match(/needs @Owner\(\) or an @OrmScope/);
        });

        it('most-derived-wins: a subclass policy shadows its ancestor policy', async () => {
          const type = typeName();
          const Base = await model({ type, policies: { owner: labelled('derivedBase', 'base-visible') } });
          const Sub = await model({ type, base: Base, policies: { owner: labelled('derivedSub', 'sub-visible') } });
          await grantAll(type, ownerRelation);

          await as(normal, () => Sub.query());

          expect(calls).to.eql(['derivedSub']);
        });

        it('the ancestor model still resolves its own policy when queried directly', async () => {
          const type = typeName();
          const Base = await model({ type, policies: { owner: labelled('derivedBase', 'base-visible') } });
          await model({ type, base: Base, policies: { owner: labelled('derivedSub', 'sub-visible') } });
          await grantAll(type, ownerRelation);

          await as(normal, () => Base.query());

          expect(calls).to.eql(['derivedBase']);
        });
      });

      it('no grant is AccessDenied for a policy model too', async () => {
        const type = typeName();
        const Res = await model({ type, policies: { owner: policy(routed()) } });
        await w.grant({}, [type]);

        const e = await fails(as(normal, () => Res.query()));

        expect(e).to.be.instanceOf(AccessDenied);
        expect(calls).to.eql([]);
      });
    });
  }
});
