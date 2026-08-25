import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User } from '../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { AccessControl } from 'accesscontrol';
import { AsyncLocalStorage } from 'async_hooks';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';

import './migration/rbac.migration.js';
import './migration/m2m.migration.js';
import { M2M_HOOK_CALLS, M2MJunctionModel, M2MLazyOwnerModel, M2MLazyTargetModel, M2MOwnerModel, M2MTargetModel, resetM2MHookCalls } from './models/M2MModels.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * The rbac hook of a model reached through a hasManyToMany relation.
 *
 * `ManyToManyRelation` builds two query builders for one logical relation query: a relation
 * query selecting FROM the target table, and a join query selecting FROM the junction table
 * which the relation query is folded into at compile time. Both carried the target model, so
 * both were handed to the query middlewares — and the rbac constraint the hook produced on the
 * second one was stamped with the JUNCTION table's alias, referencing a column that table does
 * not have.
 *
 * The visible symptoms were a doubled hook invocation and a driver-level "unknown column"
 * error, and the workaround in the wild was to defer the constraint with `Lazy` and bail out
 * unless the compile-time FROM table happened to be the target's own. The fixture's hook is
 * written without any of that on purpose.
 */
describe('rbac on a hasManyToMany target model', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);

    resetM2MHookCalls();
  });

  afterEach(() => {
    DI.clearCache();
  });

  function grant(grants: Record<string, Record<string, Record<string, string[]>>>) {
    DI.get<AccessControl>('AccessControl')!.setGrants(grants);
  }

  // query builders are thenables, not Promises — await inside so callers get a real Promise
  function as<T>(user: User, role: string, fn: () => PromiseLike<T>): Promise<T> {
    const store = DI.resolve(AsyncLocalStorage);
    return store.run({ User: new User({ Id: user.Id, Role: [role] }) }, async () => await fn());
  }

  /**
   * Seeded outside any AsyncLocalStorage store, so no constraint applies and every row lands:
   * one owner linked to three targets, two of which the hook will accept.
   */
  async function seed() {
    const user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

    const owner = new M2MOwnerModel({ Value: 'owner' } as any);
    await owner.insert();

    const targets = [
      { Segment: 'allowed', Value: 'first' },
      { Segment: 'blocked', Value: 'second' },
      { Segment: 'allowed', Value: 'third' },
    ];

    for (const t of targets) {
      const target = new M2MTargetModel({ UserId: user.Id, ...t } as any);
      await target.insert();
      await new M2MJunctionModel({ owner_id: owner.Id, target_id: target.Id } as any).insert();
    }

    resetM2MHookCalls();

    return { user, owner };
  }

  it('applies the hook to the relation, narrowing it to the rows the rule allows', async () => {
    grant({ r: { M2MTarget: { 'read:own': ['*'] } } });
    const { user, owner } = await seed();

    const rows = (await as(user, 'r', () => M2MOwnerModel.select().where('Id', owner.Id).populate('Targets'))) as M2MOwnerModel[];

    expect(rows).to.be.an('array').with.length(1);

    const targets = [...(rows[0].Targets as any)] as M2MTargetModel[];
    expect(targets.map((t) => t.Value).sort()).to.eql(['first', 'third']);
  });

  it('invokes the hook once, not once per builder the relation is made of', async () => {
    grant({ r: { M2MTarget: { 'read:own': ['*'] } } });
    const { user, owner } = await seed();

    await as(user, 'r', () => M2MOwnerModel.select().where('Id', owner.Id).populate('Targets'));

    expect(M2M_HOOK_CALLS).to.eql(['rbacRead']);
  });

  it('leaves the relation untouched for an :any grant', async () => {
    grant({ admin: { M2MTarget: { 'read:any': ['*'] } } });
    const { user, owner } = await seed();

    const rows = (await as(user, 'admin', () => M2MOwnerModel.select().where('Id', owner.Id).populate('Targets'))) as M2MOwnerModel[];

    const targets = [...(rows[0].Targets as any)] as M2MTargetModel[];
    expect(targets.map((t) => t.Value).sort()).to.eql(['first', 'second', 'third']);
    expect(M2M_HOOK_CALLS).to.eql([]);
  });

  /**
   * The pre-fix workaround must keep working unchanged — models already shipped with it, and
   * they should not have to be edited in lockstep with the ORM.
   */
  it('keeps a Lazy-deferred, table-guarded hook working', async () => {
    grant({ r: { M2MLazyTarget: { 'read:own': ['*'] } } });
    const { user, owner } = await seed();

    const rows = (await as(user, 'r', () => M2MLazyOwnerModel.select().where('Id', owner.Id).populate('Targets'))) as M2MLazyOwnerModel[];

    const targets = [...(rows[0].Targets as any)] as M2MLazyTargetModel[];
    expect(targets.map((t) => t.Value).sort()).to.eql(['first', 'third']);
    expect(M2M_HOOK_CALLS).to.eql(['rbacRead:lazy']);
  });

  it('still constrains the target when it is queried directly', async () => {
    grant({ r: { M2MTarget: { 'read:own': ['*'] } } });
    const { user } = await seed();

    const rows = (await as(user, 'r', () => M2MTargetModel.select())) as M2MTargetModel[];

    expect(rows.map((t) => t.Value).sort()).to.eql(['first', 'third']);
    expect(M2M_HOOK_CALLS).to.eql(['rbacRead']);
  });
});
