import 'mocha';

import type { Principal, ResourceRef } from '@spinajs/authz';
import { agentPrincipal, runAdapterConformance, userPrincipal } from '@spinajs/authz-testing';
import type { AdapterSetup } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IWhereBuilder, ModelBase } from '@spinajs/orm';

import { OrmResourceAdapter } from '../src/adapter.js';
import { AccessResource, OrmScope, OrmScopePolicy, Owner, ScopeColumn } from '../src/index.js';
import { replaceRows, sqliteRow } from './support/b06.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { allRows, sqlIds } from './support/residual.js';

// Plan L4 task 11: the kit's adapter conformance for OrmResourceAdapter, its `compiles` judged by
// the kit oracle against the residual compiled to SQL. Two inputs stay out because the SQL is
// "sound only" there (conventions §5), and one because the oracle still reads it otherwise than
// the engine: a canonical number string in a text cell (compared with a number, SQL answers
// UNKNOWN where the engine decides), a glob with a single '*' that is not trailing (UNKNOWN on
// SQLite), and a like pattern ending in a lone '\' (the engine: UNKNOWN; the oracle: a literal '\';
// RFC L4-2).
const SEED = 20261104;
const RUNS = 100;
const TYPE = 'cftask';

const alice = userPrincipal('alice', { attributes: { team: 'red' } });
const bob = userPrincipal('bob', { attributes: { team: 'blue' } });
const carol = userPrincipal('carol');
const PRINCIPALS: readonly Principal[] = [alice, bob, carol, agentPrincipal('bot', alice, { delegation: 'inherit' })];

// SQLite keeps a stored 2 in a BOOLEAN column; the converter reads only 1 as true.
const rows = (dialect: Dialect) => [
  { id: 'r1', title: 'a', owner: 'alice', team: 'red', project_id: 'p1', n: 0, k: 2, flag: true },
  { id: 'r2', title: 'a%b', owner: 'bob', team: 'blue', project_id: 'p2', n: 1, k: -3, flag: false },
  { id: 'r3', title: 'a_b', owner: 'Alice', team: 'red', project_id: null, n: 2.5, k: 0, flag: dialect === 'sqlite' ? 2 : true },
  { id: 'r4', title: 'x/y', owner: null, team: null, project_id: 'p1', n: null, k: 1, flag: null },
  { id: 'r5', title: 'x/y/z', owner: 'carol', team: 'blue', project_id: 'p2', n: 10, k: null, flag: true },
  { id: 'r6', title: '01', owner: 'alice', team: 'red', project_id: 'p1', n: -4, k: 7, flag: false },
  { id: 'r7', title: 'a\\', owner: 'bob', team: null, project_id: 'p9', n: 3.5, k: 1, flag: null },
  { id: 'r8', title: '', owner: 'alice', team: 'blue', project_id: null, n: 1, k: 2, flag: true },
  { id: 'r9', title: '1.0', owner: 'bot', team: 'red', project_id: 'p2', n: null, k: 0, flag: false },
];
const COLUMNS: Record<Dialect, Record<string, string>> = {
  sqlite: { title: 'TEXT', owner: 'TEXT', team: 'TEXT', project_id: 'TEXT', n: 'REAL', k: 'INTEGER', flag: 'BOOLEAN' },
  postgres: { title: 'TEXT', owner: 'TEXT', team: 'TEXT', project_id: 'TEXT', n: 'DOUBLE PRECISION', k: 'INTEGER', flag: 'BOOLEAN' },
};
const VALUES: readonly (string | number)[] = ['a', 'b', 'ab', 'a%', '%', '_', 'a_b', 'a\\%', 'a\\\\', '\\_', 'a*', '**', 'x/*', 'x/**', 'x/y', 'red', 'alice', '01', '1', '2.5', 0, 1, 2, 2.5, -4, 10];

let seq = 0;

/** The `team` relation: rows of the principal's team. */
function teamPolicy() {
  const Policy = class extends OrmScopePolicy {
    scope(q: IWhereBuilder<never>, p: Principal): void {
      const team = p.attributes?.team;
      if (typeof team === 'string') q.where('team' as never, team as never);
      else q.where(false as never);
    }
  };
  // DI keys classes by name.
  Object.defineProperty(Policy, 'name', { value: `CfTeamPolicy_${++seq}` });
  return Policy;
}

describe('authz-orm adapter conformance', function () {
  this.timeout(600000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      runAdapterConformance(
        `OrmResourceAdapter on ${dialect} (seed ${SEED}, ${RUNS} runs)`,
        async (): Promise<AdapterSetup<ModelBase>> => {
          const policy = teamPolicy();
          const model = await db.define(
            {
              name: 'CfTask',
              columns: COLUMNS[dialect],
              decorate: (cls, proto) => {
                AccessResource(TYPE)(cls);
                Owner()(proto, 'owner');
                ScopeColumn('project_id', 'project')(proto, 'project_id');
                OrmScope(cls as never, 'team')(policy);
              },
            },
            dialect,
          );
          const data = rows(dialect);
          await replaceRows(db, db.table(model), dialect, dialect === 'sqlite' ? data.map(sqliteRow) : data);
          return {
            adapter: new OrmResourceAdapter(),
            targets: await allRows(model),
            principals: PRINCIPALS,
            fields: ['title', 'owner', 'team', 'project_id', 'n', 'k', 'flag'],
            values: VALUES,
            refs: ['principal.id', 'principal.attributes.team'],
            query: async (filter, q) => (await sqlIds(model, filter, q.principal)).map((id): ResourceRef => ({ type: TYPE, id })),
            dispose: async () => {
              await db.clear();
              DI.uncache(policy as never);
            },
          };
        },
        { seed: SEED, numRuns: RUNS },
      );
    });
  }
});
