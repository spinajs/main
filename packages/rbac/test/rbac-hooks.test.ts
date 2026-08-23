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
import { AllHooksModel, AsyncCreateHookModel, GenericHookModel, HOOK_CALLS, InheritedHookModel, LazyHookModel, PartialHookModel, resetHookCalls } from './models/HookModels.js';
import { ResourceModel } from './models/ResourceModel.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Per-operation rbac hooks.
 *
 * A model used to declare exactly one custom rbac constraint, `rbac`, shared by reads,
 * updates and deletes — so a rule that must be narrower for deletes than for reads had
 * nowhere to live. `rbacRead` / `rbacUpdate` / `rbacDelete` / `rbacCreate` split it per
 * operation, with `rbac` remaining the fallback for everything except create.
 */
describe('Per-operation rbac hooks', function () {
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

    resetHookCalls();
  });

  afterEach(() => {
    DI.clearCache();
  });

  function grant(grants: Record<string, Record<string, Record<string, string[]>>>) {
    DI.get<AccessControl>('AccessControl')!.setGrants(grants);
  }

  /**
   * Runs outside any AsyncLocalStorage store, so the middleware sees no user and applies
   * no constraint — rows land regardless of the hooks under test.
   */
  async function seed() {
    const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

    for (const Value of ['readable', 'updatable', 'deletable', 'generic', 'other']) {
      await new AllHooksModel({ UserId: owner.Id, Value } as any).insert();
    }

    // `destroy()` refuses an unbounded DELETE, so every delete case passes the full id set
    // and lets the rbac hook narrow it down
    const ids = (await AllHooksModel.select()).map((x) => x.Id);

    return { owner, ids };
  }

  // query builders are thenables, not Promises — await inside so callers get a real Promise
  function as<T>(user: User, role: string, fn: () => PromiseLike<T>): Promise<T> {
    const store = DI.resolve(AsyncLocalStorage);
    return store.run({ User: new User({ Id: user.Id, Role: [role] }) }, async () => await fn());
  }

  describe('specific hook wins over the generic one', () => {
    it('select uses rbacRead', async () => {
      grant({ r: { HookAll: { 'read:own': ['*'] } } });
      const { owner } = await seed();

      const rows = (await as(owner, 'r', () => AllHooksModel.select())) as AllHooksModel[];

      expect(HOOK_CALLS).to.eql(['rbacRead']);
      expect(rows).to.be.an('array').with.length(1);
      expect(rows[0].Value).to.eq('readable');
    });

    it('update uses rbacUpdate', async () => {
      grant({ r: { HookAll: { 'update:own': ['*'] } } });
      const { owner } = await seed();

      await as(owner, 'r', () => AllHooksModel.update({ UserId: 999 } as any));

      expect(HOOK_CALLS).to.eql(['rbacUpdate']);

      const touched = await AllHooksModel.where('UserId', 999);
      expect(touched).to.be.an('array').with.length(1);
      expect(touched[0].Value).to.eq('updatable');
    });

    it('delete uses rbacDelete', async () => {
      grant({ r: { HookAll: { 'delete:own': ['*'] } } });
      const { owner, ids } = await seed();

      await as(owner, 'r', () => AllHooksModel.destroy(ids));

      expect(HOOK_CALLS).to.eql(['rbacDelete']);

      const left = (await AllHooksModel.select()).map((x) => x.Value).sort();
      expect(left).to.eql(['generic', 'other', 'readable', 'updatable']);
    });

    it('insert uses rbacCreate and suppresses OwnerField stamping', async () => {
      grant({ r: { HookAll: { 'create:own': ['*'] } } });
      const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

      await as(owner, 'r', async () => {
        await new AllHooksModel({ UserId: 4242, Value: 'from-payload' } as any).insert();
      });

      expect(HOOK_CALLS).to.eql(['rbacCreate']);

      const row = await AllHooksModel.where('Value', 'stamped-by-hook').firstOrFail();

      // the hook took over completely: it rewrote Value and the middleware did NOT then
      // overwrite UserId from the acting user, exactly as `rbac` displaces the OwnerField
      // where-clause on the other three operations
      expect(row.UserId).to.eq(4242);
    });

    it('hooks are inherited by a subclass that overrides nothing', async () => {
      grant({ r: { HookInherited: { 'read:own': ['*'] } } });
      const { owner } = await seed();

      const rows = (await as(owner, 'r', () => InheritedHookModel.select())) as InheritedHookModel[];

      expect(HOOK_CALLS).to.eql(['rbacRead']);
      expect(rows).to.be.an('array').with.length(1);
      expect(rows[0].Value).to.eq('readable');
    });
  });

  describe('fallback to the generic rbac hook', () => {
    it('a model declaring only rbac keeps it on read, update and delete', async () => {
      grant({ r: { HookGeneric: { 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] } } });
      const { owner, ids } = await seed();

      const rows = (await as(owner, 'r', () => GenericHookModel.select())) as GenericHookModel[];
      expect(rows).to.be.an('array').with.length(1);
      expect(rows[0].Value).to.eq('generic');

      await as(owner, 'r', () => GenericHookModel.update({ UserId: 888 } as any));
      await as(owner, 'r', () => GenericHookModel.destroy(ids));

      expect(HOOK_CALLS).to.eql(['rbac', 'rbac', 'rbac']);

      const left = (await AllHooksModel.select()).map((x) => x.Value).sort();
      expect(left).to.eql(['deletable', 'other', 'readable', 'updatable']);
    });

    it('a model declaring rbacDelete only falls back for read and update', async () => {
      grant({ r: { HookPartial: { 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] } } });
      const { owner, ids } = await seed();

      await as(owner, 'r', () => PartialHookModel.select());
      await as(owner, 'r', () => PartialHookModel.update({ UserId: 777 } as any));
      await as(owner, 'r', () => PartialHookModel.destroy(ids));

      expect(HOOK_CALLS).to.eql(['rbac', 'rbac', 'rbacDelete']);
    });

    /**
     * The one asymmetry. `rbac` has only ever been called on builders that have a WHERE
     * clause, so every implementation in the wild is where-shaped and InsertQueryBuilder
     * has no `where`. Falling back would crash every insert for every model already using
     * the feature — `GenericHookModel.rbac` calls `where` precisely so that regression
     * would surface here rather than pass silently.
     */
    it('insert does NOT fall back to rbac, and still stamps OwnerField', async () => {
      grant({ r: { HookGeneric: { 'create:own': ['*'] } } });
      const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

      await as(owner, 'r', async () => {
        await new GenericHookModel({ UserId: 4242, Value: 'no-create-hook' } as any).insert();
      });

      expect(HOOK_CALLS).to.eql([]);

      const row = await GenericHookModel.where('Value', 'no-create-hook').firstOrFail();
      expect(row.UserId).to.eq(owner.Id);
    });
  });

  /**
   * `beforeQueryExecution` used to be dispatched with `forEach`, so a hook that returned a
   * promise had it dropped on the floor and the INSERT went ahead regardless. For a
   * security check that is the difference between enforcing and pretending to — and insert
   * ownership is exactly the case that needs IO, since there is no WHERE clause to carry it.
   */
  describe('async rbacCreate', () => {
    it('is awaited before the row is written', async () => {
      grant({ r: { HookAsync: { 'create:own': ['*'] } } });
      const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
      AsyncCreateHookModel.AllowedOwners = [owner.Id];

      await as(owner, 'r', async () => {
        await new AsyncCreateHookModel({ UserId: owner.Id, Value: 'from-payload' } as any).insert();
      });

      expect(HOOK_CALLS).to.eql(['rbacCreate:start', 'rbacCreate:allow']);

      // the value the hook wrote AFTER its await is the one that landed
      const row = await AsyncCreateHookModel.where('Value', `checked-for-${owner.Id}`).firstOrFail();
      expect(row.UserId).to.eq(owner.Id);
    });

    it('aborts the insert when it rejects after its await', async () => {
      grant({ r: { HookAsync: { 'create:own': ['*'] } } });
      const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
      AsyncCreateHookModel.AllowedOwners = [owner.Id];

      await expect(
        as(owner, 'r', async () => {
          await new AsyncCreateHookModel({ UserId: owner.Id + 999, Value: 'forged' } as any).insert();
        }),
      ).to.be.rejectedWith(/is not assigned to this user/);

      expect(HOOK_CALLS).to.eql(['rbacCreate:start', 'rbacCreate:reject']);
      expect(await AsyncCreateHookModel.where('Value', 'forged').first()).to.be.undefined;
    });

    it('getColumnValues reads the payload the hook is about to write', async () => {
      grant({ r: { HookAsync: { 'create:own': ['*'] } } });
      const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
      AsyncCreateHookModel.AllowedOwners = [owner.Id, owner.Id + 1];

      // a multi-row insert: the hook must see BOTH owners, not just the first row's
      await as(owner, 'r', () =>
        AsyncCreateHookModel.insert([
          { UserId: owner.Id, Value: 'a' },
          { UserId: owner.Id + 1, Value: 'b' },
        ] as any),
      );

      expect(HOOK_CALLS).to.eql(['rbacCreate:start', 'rbacCreate:allow']);

      const rows = await AsyncCreateHookModel.where('Value', `checked-for-${owner.Id}`);
      expect(rows.map((x) => x.UserId).sort()).to.eql([owner.Id, owner.Id + 1]);
    });

  });

  /**
   * A hook must run EXACTLY once per query it constrains.
   *
   * `SelectQueryBuilder.clone()` used to re-enter the middleware from the clone's constructor
   * and then overwrite every statement the second pass produced with a copy of the source's —
   * so the hook fired twice and the extra run was silently discarded. Harmless for a hook that
   * only adds a where clause, not harmless for one that does a lookup, counts, or registers a
   * relation.
   *
   * The compile-time path matters more than the explicit `clone()`: a `Lazy` where-statement is
   * evaluated by `SqlLazyQueryStatement.build()`, which clones the builder — so a Lazy-based
   * hook doubled on EVERY compile, without anybody calling `clone()`.
   */
  describe('a hook runs exactly once per query', () => {
    it('clone() does not re-run the hook', async () => {
      grant({ r: { HookAll: { 'read:own': ['*'] } } });
      const { owner } = await seed();

      resetHookCalls();

      await as(owner, 'r', async () => {
        const query = AllHooksModel.select();
        const countQuery = query.clone();

        await query;
        await countQuery.selectCount();
      });

      expect(HOOK_CALLS).to.eql(['rbacRead']);
    });

    it('a Lazy hook is not re-run when the deferred statement compiles', async () => {
      grant({ r: { HookLazy: { 'read:own': ['*'] } } });
      const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

      await new LazyHookModel({ UserId: owner.Id, Value: 'readable' } as any).insert();
      await new LazyHookModel({ UserId: owner.Id, Value: 'other' } as any).insert();

      resetHookCalls();

      const rows = (await as(owner, 'r', () => LazyHookModel.select())) as LazyHookModel[];

      expect(HOOK_CALLS).to.eql(['rbacRead']);
      expect(rows).to.be.an('array').with.length(1);
      expect(rows[0].Value).to.eq('readable');
    });
  });

  describe('unchanged behaviour', () => {
    it('an :any grant short-circuits before any hook runs', async () => {
      grant({ admin: { HookAll: { 'read:any': ['*'], 'delete:any': ['*'] } } });
      const { owner } = await seed();

      const rows = (await as(owner, 'admin', () => AllHooksModel.select())) as AllHooksModel[];

      expect(HOOK_CALLS).to.eql([]);
      expect(rows).to.be.an('array').with.length(5);
    });

    it('a model with no hook at all still falls through to OwnerField on delete', async () => {
      grant({ r: { Test: { 'delete:own': ['*'] } } });
      const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

      await new ResourceModel({ UserId: owner.Id, Value: 'mine' } as any).insert();
      await new ResourceModel({ UserId: owner.Id + 999, Value: 'theirs' } as any).insert();

      const ids = (await ResourceModel.select()).map((x) => x.Id);

      await as(owner, 'r', () => ResourceModel.destroy(ids));

      expect(HOOK_CALLS).to.eql([]);

      const left = await ResourceModel.select();
      expect(left).to.be.an('array').with.length(1);
      expect(left[0].Value).to.eq('theirs');
    });

    it('no permission is still Forbidden, whichever hooks the model declares', async () => {
      grant({ r: { HookAll: { 'read:own': ['*'] } } });
      const { owner, ids } = await seed();

      await expect(as(owner, 'r', () => AllHooksModel.destroy(ids))).to.be.rejectedWith(/HookAll:delete/);
      expect(HOOK_CALLS).to.eql([]);
    });
  });
});
