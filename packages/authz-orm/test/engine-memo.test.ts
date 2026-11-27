import * as chai from 'chai';
import 'mocha';

import { FALSE, ScopeAttributeStore, TRUE, runWithPrincipal } from '@spinajs/authz';
import type { AuthzService, Decision, Principal, ResourceRef } from '@spinajs/authz';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { AccessResource, DbScopeAttributeStore, Parent } from '../src/index.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { createAncestorTable, dropAncestorTable, insertLinks } from './support/ancestors.js';
import { createScopeAttributeTables, dropScopeAttributeTables } from './support/scope-attributes.js';

const expect = chai.expect;
const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {} });
const TASK: ResourceRef = { type: 'task', id: '7' };
const ORG: ResourceRef = { type: 'org', id: 'o1' };
const DEADLINE_MS = 10000;
const MAX_TICKS = 60;

/** Rejects with `what` when `work` has not settled after `ms`, so a hang fails its own test instead of reaching mocha's timeout. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still running after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** `outer` and `inner` in one request and one transaction; `inner` in a nested transaction opened `ticks` microtasks later. */
function beside<T>(driver: OrmDriver, ticks: number, outer: () => Promise<T>, inner: () => Promise<T>): Promise<T[]> {
  return runWithPrincipal(user('alice'), () =>
    driver.transaction(() =>
      Promise.all([
        outer(),
        (async () => {
          for (let i = 0; i < ticks; i++) await Promise.resolve();
          return driver.transaction(inner);
        })(),
      ]),
    ),
  );
}

describe('AuthzService.check beside a nested transaction of the same request (the engine request memo)', function () {
  this.timeout(120000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open({ pglite: true });
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'pglite'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        await createScopeAttributeTables(db, dialect);
        await db.useAuthz(dialect);
        await db.define(
          {
            name: 'Task',
            columns: { id: 'INTEGER', project_id: 'TEXT', title: 'TEXT' },
            rows: [{ id: 7, project_id: 'p1', title: 'a' }],
            decorate: (cls, proto) => {
              AccessResource('task')(cls);
              Parent('project')(proto, 'project_id');
            },
          },
          dialect,
        );
        await insertLinks(db.driver(dialect), ['task:7>project:p1@1']);
      });

      afterEach(async () => {
        await db.clear();
        await db.useAuthz('sqlite');
        await dropScopeAttributeTables(db, dialect);
        await dropAncestorTable(db, dialect);
      });

      it('two checks of one concrete resource settle, one inside a nested transaction, however late it opens', async () => {
        const service = await (await testHost.domains()).service('root');
        const driver = db.driver(dialect);
        const check = (p: Principal) => () => service.check({ principal: p, permission: 'task:read', resource: TASK });
        const all = (p: Principal) => () => service.checkAll(p, [{ permission: 'task:read', resource: TASK }]).then((d) => d[0]);
        const plain = await runWithPrincipal(user('alice'), check(user('alice')));
        const shapes: Record<string, [() => Promise<Decision>, () => Promise<Decision>]> = {
          'same principal': [check(user('alice')), check(user('alice'))],
          'another principal inside': [check(user('alice')), check(user('bob'))],
          'checkAll inside': [check(user('alice')), all(user('alice'))],
          'checkAll outside': [all(user('alice')), check(user('alice'))],
        };
        for (const [shape, [outer, inner]] of Object.entries(shapes)) {
          for (let ticks = 0; ticks <= MAX_TICKS; ticks++) {
            const decisions = await within(DEADLINE_MS, `${dialect} ${shape}, ${ticks} microtasks later`, beside(driver, ticks, outer, inner));
            expect(decisions.map((d) => d.allowed)).to.deep.equal([plain.allowed, plain.allowed]);
          }
        }
      });

      it('a model reading scope attributes from the DB store answers both checks without waiting for modelTimeoutMs', async () => {
        const ds = await testHost.domains();
        const name = `memo${dialect}`;
        const config = testHost.config();
        config.set(['authz', 'domains', name], { permissions: { 'org:audit': { types: ['org'] } }, combine: { default: { algorithm: 'deny-overrides', models: ['attrs'] } } });
        const container: IContainer = ds.create(name, 'root');
        try {
          const reads = new StaticModel({
            name: 'attrs',
            capabilities: { sync: 'never' },
            votes: async (_req, ctx) => ({ permitWhen: (await ctx.attributes(ORG)) === null ? FALSE : TRUE, cacheable: false }),
          });
          testHost.activate(container, name, reads);
          container.register(DbScopeAttributeStore).as(ScopeAttributeStore);
          const service: AuthzService = await ds.service(name);
          const driver = db.driver(dialect);
          const check = () => service.check({ principal: user('alice'), permission: 'org:audit', resource: { type: 'org' } });
          for (let ticks = 0; ticks <= 20; ticks++) {
            const started = Date.now();
            const decisions = await within(DEADLINE_MS, `${dialect} attributes, ${ticks} microtasks later`, beside(driver, ticks, check, check));
            expect(Date.now() - started, `${ticks} microtasks later, ms`).to.be.below(1500);
            expect(decisions.map((d) => [d.allowed, d.reason?.code])).to.deep.equal([
              [true, undefined],
              [true, undefined],
            ]);
          }
        } finally {
          await container.dispose();
          config.unset(['authz', 'domains', name]);
        }
      });
    });
  }
});
