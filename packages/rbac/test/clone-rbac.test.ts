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
import { CloneRbacModel } from './models/CloneModels.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * A cloned query must be constrained exactly as the query it was cloned from.
 *
 * The rbac model-permission middleware injects its where clause at query CONSTRUCTION
 * (`afterQueryCreation`). Paginated list endpoints universally take the constrained query,
 * `clone()` it for the row count, and only then `populate()` the original:
 *
 *   const query = Model.select().filter(...);
 *   const countQuery = query.clone();
 *   const rows  = await query.populate(include).take(limit);
 *   const count = await countQuery.selectCount();     // -> X-Total-Count
 *
 * If the clone loses the constraint, the count is computed over the WHOLE table while the rows
 * are correctly restricted — so the header discloses how many rows exist outside the caller's
 * permission scope. That is an information leak, not a cosmetic mismatch, which is why this is
 * asserted here rather than left to the SQL-shape tests in orm-sql.
 */
describe('rbac constraints survive query cloning', function () {
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
   * Seeded outside any AsyncLocalStorage store, so the middleware applies no constraint and
   * every row lands: three owned by the acting user, four owned by somebody else.
   */
  async function seed() {
    const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

    for (const Value of ['a', 'b', 'c']) {
      await new CloneRbacModel({ UserId: owner.Id, Value } as any).insert();
    }

    for (const Value of ['d', 'e', 'f', 'g']) {
      await new CloneRbacModel({ UserId: owner.Id + 999, Value } as any).insert();
    }

    return { owner, owned: 3, total: 7 };
  }

  /** The exact shape a paginated controller uses: clone for the count, then populate the rows. */
  async function listAndCount(model = CloneRbacModel) {
    const query = model.select();
    const countQuery = query.clone();

    const rows = await query.populate('Owner');
    const count = await countQuery.selectCount();

    return { rows, count };
  }

  it('a readOwn caller gets a count that matches the rows it is allowed to see', async () => {
    grant({ r: { CloneRbac: { 'read:own': ['*'] } } });
    const { owner, owned } = await seed();

    const { rows, count } = await as(owner, 'r', () => listAndCount());

    expect(rows).to.be.an('array').with.length(owned);
    expect(count).to.eq(owned);
  });

  it('a readAny caller still counts everything', async () => {
    grant({ r: { CloneRbac: { 'read:any': ['*'] } } });
    const { owner, total } = await seed();

    const { rows, count } = await as(owner, 'r', () => listAndCount());

    expect(rows).to.be.an('array').with.length(total);
    expect(count).to.eq(total);
  });

  it('the clone is constrained even when it is compiled before the original', async () => {
    grant({ r: { CloneRbac: { 'read:own': ['*'] } } });
    const { owner, owned } = await seed();

    const result = await as(owner, 'r', async () => {
      const query = CloneRbacModel.select();
      const countQuery = query.clone();

      // count first this time: the constraint must not depend on which query compiles first
      const count = await countQuery.selectCount();
      const rows = await query.populate('Owner');

      return { count, rows };
    });

    expect(result.rows).to.be.an('array').with.length(owned);
    expect(result.count).to.eq(owned);
  });

  it('a clone of a clone stays constrained', async () => {
    grant({ r: { CloneRbac: { 'read:own': ['*'] } } });
    const { owner, owned } = await seed();

    const count = await as(owner, 'r', () => CloneRbacModel.select().clone().clone().selectCount());

    expect(count).to.eq(owned);
  });

  it('a caller-supplied filter narrows both the rows and the count', async () => {
    grant({ r: { CloneRbac: { 'read:own': ['*'] } } });
    const { owner } = await seed();

    const result = await as(owner, 'r', async () => {
      const query = CloneRbacModel.select().where('Value', 'a');
      const countQuery = query.clone();

      const rows = await query.populate('Owner');
      const count = await countQuery.selectCount();

      return { rows, count };
    });

    expect(result.rows).to.be.an('array').with.length(1);
    expect(result.count).to.eq(1);
  });
});
