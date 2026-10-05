import * as chai from 'chai';
import 'mocha';

import type { ResourceFilter } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { BelongsTo, HasManyToMany, ManyToManyRelationList, ModelBase } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { AccessResource, OrmScope, OrmScopePolicy } from '../../src/index.js';
import type { Dialect } from '../support/db.js';
import { DIALECTS, PortedWorld, as, permit, user } from './harness.js';

const expect = chai.expect;

type Static = typeof ModelBase & { query(): any; where(...a: unknown[]): any; select(): any };

const TARGET = 'm2mtarget';
const READ = `${TARGET}:read`;
const segment: ResourceFilter = { op: 'relation', relation: 'segment' };

// Ported from users legacy-v2/m2m-rbac.test.ts (B20, B21, B15): the rule of a model reached through a
// hasManyToMany relation. The 2.x `OrmPermission` hook `q.where('Segment', 'allowed')` is an @OrmScope
// policy over the `segment` relation; the grant (`read:own` there) is a permit under that relation.
describe('rbac on a hasManyToMany target model', function () {
  this.timeout(60000);
  const w = new PortedWorld();
  const normal = user('1');
  const hookCalls: string[] = [];
  const policies: (abstract new () => unknown)[] = [];

  before(() => w.open());
  after(() => w.close());
  afterEach(async () => {
    hookCalls.length = 0;
    await w.reset();
    for (const p of policies.splice(0)) DI.uncache(p as never);
  });

  // DI keys classes by name, so a same-named policy of a later case would resolve to this one.
  let seq = 0;
  function segmentPolicy(): abstract new () => OrmScopePolicy {
    class SegmentPolicy extends OrmScopePolicy {
      scope(q: IWhereBuilder<ModelBase>): void {
        hookCalls.push('rbacRead');
        q.where('Segment', 'allowed');
      }
    }
    Object.defineProperty(SegmentPolicy, 'name', { value: `SegmentPolicy_${++seq}` });
    policies.push(SegmentPolicy);
    return SegmentPolicy;
  }

  /** How often `value` is bound by the statements `fn` sends to the driver. */
  async function boundTimes(dialect: Dialect, value: string, fn: () => Promise<unknown>): Promise<number> {
    const d = w.db.driver(dialect) as unknown as { executeOnDb(sql: string, bindings: unknown[], ctx: unknown): Promise<unknown> };
    const original = d.executeOnDb;
    let count = 0;
    d.executeOnDb = function (this: unknown, sql: string, bindings: unknown[], ctx: unknown) {
      count += (bindings ?? []).filter((x) => x === value).length;
      return original.call(this, sql, bindings, ctx);
    };
    try {
      await fn();
    } finally {
      d.executeOnDb = original;
    }
    return count;
  }

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !w.pg) this.skip();
      });

      /**
       * One owner linked to three targets, two of which the policy accepts. Seeded unscoped: raw
       * inserts bypass the middleware.
       */
      async function seed(dialect: Dialect, grant: Parameters<PortedWorld['grant']>[0], opts: Parameters<PortedWorld['grant']>[2] = {}) {
        const Target = (await w.db.define(
          {
            name: 'Target',
            columns: { UserId: 'TEXT', Segment: 'TEXT', Value: 'TEXT' },
            decorate: (cls) => {
              AccessResource(TARGET)(cls);
              OrmScope(cls as never, 'segment')(segmentPolicy() as never);
            },
          },
          dialect,
        )) as Static;
        const Junction = await w.db.define(
          {
            name: 'Junction',
            columns: { owner_id: 'TEXT', target_id: 'TEXT' },
            decorate: (_cls, proto) => BelongsTo(Target as never, 'target_id', 'id')(proto, 'target'),
          },
          dialect,
        );
        const Owner = (await w.db.define({ name: 'Owner', columns: { Value: 'TEXT' } }, dialect)) as Static;
        HasManyToMany(Junction as never, Target as never, { targetModelPKey: 'id', sourceModelPKey: 'id', junctionModelTargetPk: 'target_id', junctionModelSourcePk: 'owner_id', type: ManyToManyRelationList as never })(Owner.prototype, 'Targets');
        (w.db.orm as unknown as { wireRelations(): void }).wireRelations();

        await w.db.insertRaw(Owner, { id: 'o1', Value: 'owner' });
        const targets = [
          { id: 't1', Segment: 'allowed', Value: 'first' },
          { id: 't2', Segment: 'blocked', Value: 'second' },
          { id: 't3', Segment: 'allowed', Value: 'third' },
        ];
        for (const t of targets) {
          await w.db.insertRaw(Target, { UserId: normal.id, ...t });
          await w.db.insertRaw(Junction, { id: `j-${t.id}`, owner_id: 'o1', target_id: t.id });
        }
        await w.grant(grant, [TARGET], opts);
        return { Target, Owner };
      }

      const withTargets = (Owner: Static) => () => Owner.select().where('id', 'o1').populate('Targets');
      const valuesOf = (rows: any[]): string[] => ([...rows[0].Targets] as { Value: string }[]).map((t) => t.Value).sort();

      it('applies the hook to the relation, narrowing it to the rows the rule allows', async () => {
        const { Owner } = await seed(dialect, { [READ]: permit(segment) });

        const rows = (await as(normal, withTargets(Owner))) as any[];

        expect(rows).to.be.an('array').with.length(1);
        expect(valuesOf(rows)).to.eql(['first', 'third']);
      });

      it('invokes the hook once, not once per builder the relation is made of', async () => {
        const { Owner } = await seed(dialect, { [READ]: permit(segment) });

        await as(normal, withTargets(Owner));

        expect(hookCalls).to.eql(['rbacRead']);
        // the scope reaches the SQL once too: 'allowed' binds once, not once per builder
        hookCalls.length = 0;
        expect(await boundTimes(dialect, 'allowed', () => as(normal, withTargets(Owner)))).to.equal(1);
      });

      it('leaves the relation untouched for an :any grant', async () => {
        const { Owner } = await seed(dialect, { [READ]: permit() });

        const rows = (await as(normal, withTargets(Owner))) as any[];

        expect(valuesOf(rows)).to.eql(['first', 'second', 'third']);
        expect(hookCalls).to.eql([]);
      });

      // Changed expectation (B20): the 2.x `Lazy`-deferred, table-guarded hook is a deferred residual,
      // a model with sync 'never'; the middleware marks the builder and compiles it before the query runs.
      it('keeps a Lazy-deferred, table-guarded hook working', async () => {
        const { Owner } = await seed(dialect, { [READ]: permit(segment) }, { sync: 'never' });

        const rows = (await as(normal, withTargets(Owner))) as any[];

        expect(valuesOf(rows)).to.eql(['first', 'third']);
        expect(hookCalls).to.eql(['rbacRead']);
      });

      it('still constrains the target when it is queried directly', async () => {
        const { Target } = await seed(dialect, { [READ]: permit(segment) });

        const rows = (await as(normal, () => Target.select())) as unknown as { Value: string }[];

        expect(rows.map((t) => t.Value).sort()).to.eql(['first', 'third']);
        expect(hookCalls).to.eql(['rbacRead']);
      });
    });
  }
});
