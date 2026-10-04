import { strict as assert } from 'node:assert';
import 'mocha';

import { CORE_FILTER_OPS } from '@spinajs/authz';
import { FAKE_TUPLE_OP, fixtureDsl, runBehaviour } from '@spinajs/authz-testing';
import type { BehaviourSelector, World } from '@spinajs/authz-testing';

import { TestDb } from './support/db.js';
import { ormHarness, tablesOf } from './support/orm-harness.js';

// Plan L4 task 11: the ORM parts of the kit's behaviour fixtures, on SQLite and Postgres. B06.sql
// runs the kit's agree worlds with their rows in ORM tables (native:fake.tuple through the test
// compiler of support/b06.ts); the other parts build World.lane.orm with the authz-orm decorators.
const PARTS: readonly BehaviourSelector[] = ['B05.orm', 'B06.sql', 'B09.orm', 'B20.orm', 'B21.orm', 'B22.orm', 'B39.orm'];

describe('authz-orm behaviour fixtures', function () {
  this.timeout(120000);
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

      runBehaviour(PARTS, () => ormHarness(() => db, dialect), { strict: true });
    });
  }
});

describe('ormHarness refuses kit worlds it cannot map', () => {
  const file = (adapter: Record<string, unknown>, extra: Partial<World> = {}): World => ({
    permissions: ['file:read'],
    combine: fixtureDsl.combine('deny-overrides', 'm1'),
    adapters: [{ types: ['file'], rows: { file: [{ id: 'f1', owner: 'alice', author: 'bob' }] }, ...adapter }],
    ...extra,
  });

  it('a control world maps', () => {
    assert.equal(tablesOf(file({ relations: [{ type: 'file', relation: 'owner', column: 'owner' }] })).spec.owner, 'owner');
  });

  it('owner relations on several columns (a model has one @Owner)', () => {
    const relations = [
      { type: 'file', relation: 'owner', column: 'owner' },
      { type: 'file', relation: 'owner', column: 'author' },
    ];
    assert.throws(() => tablesOf(file({ relations })), /owner relations on several columns \(owner, author\)/);
  });

  it('a compiles list narrower than the ORM adapter (a B05 rule 4 world would boot)', () => {
    assert.throws(() => tablesOf(file({ compiles: CORE_FILTER_OPS.filter((op) => op !== 'cmp') })), /compiles fewer ops than the ORM adapter \(not cmp\)/);
    const tuple = { kind: 'fake-tuple', schema: { file: { relations: { viewer: 'user' }, permissions: { view: 'viewer' } } }, permissions: { 'file:read': 'file#view' } } as const;
    assert.throws(() => tablesOf(file({}, { models: [tuple] })), new RegExp(`not ${FAKE_TUPLE_OP}`));
    assert.equal(tablesOf(file({ compiles: [...CORE_FILTER_OPS, FAKE_TUPLE_OP] }, { models: [tuple] })).spec.type, 'file');
  });
});
