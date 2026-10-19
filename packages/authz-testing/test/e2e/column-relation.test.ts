import 'mocha';
import { expect } from 'chai';

import { AuthzConfigError } from '@spinajs/authz';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, OrmModelSpec, World } from '@spinajs/authz-testing';

import { e2eHarness, withPostgres } from './support/stack.js';
import { authzOf, listed, open, stackWorld } from './support/world.js';

const { assignment, ref, role } = fixtureDsl;
const alice = userPrincipal('alice');

const task = (extra: Partial<OrmModelSpec> = {}): OrmModelSpec => ({
  name: 'Task',
  type: 'task',
  relations: [{ name: 'assignee', column: 'assignee_id' }],
  columns: ['assignee_id', 'project_id'],
  rows: [
    { id: 't1', assignee_id: 'alice', project_id: 'p1' },
    { id: 't2', assignee_id: 'bob', project_id: 'p1' },
    { id: 't3', assignee_id: 'alice', project_id: 'p2' },
  ],
  ...extra,
});
const project: OrmModelSpec = { name: 'Project', type: 'project', columns: [], rows: [{ id: 'p1' }, { id: 'p2' }] };

const worker = (relation: string) => role('worker', [{ permission: 'task:read', relation }]);
const world = (models: OrmModelSpec[], relation = 'assignee', assignments = [assignment('a1', alice, 'worker')]): World => ({
  ...stackWorld(assignments, { lane: { orm: { models } } }),
  permissions: [{ name: 'task:read', types: ['task'], list: true }, 'project:read'],
  rbac: { roles: [worker(relation)], assignments },
});

describe('e2e RBAC grant on a column relation (sqlite)', function () {
  this.timeout(120_000);
  const harness = e2eHarness('sqlite');
  let s: HarnessSession | undefined;

  before(async function () {
    await withPostgres(this, 'sqlite');
    await harness.beforeAll?.();
  });
  after(() => harness.afterAll?.());
  afterEach(async () => {
    await s?.dispose();
    s = undefined;
  });

  // A relation grant is decided against the loaded row; a bare ref only yields the type-level residual.
  const row = async (id: string): Promise<object> => (await (harness.model('Task') as unknown as { query(): any }).query().where('id', id).unscoped('e2e test'))[0];

  it('a $global grant serves .accessible() and single-object checks', async () => {
    s = await open(harness, world([task()]), 'column-relation-global');
    expect(await listed(s, alice, 'task:read')).to.deep.equal(['t1', 't3']);
    expect(await authzOf(s).can(alice, 'task:read', await row('t1'))).to.equal(true);
    expect(await authzOf(s).can(alice, 'task:read', await row('t2'))).to.equal(false);
  });

  it('a project-scoped grant lists only the assigned tasks under that project', async () => {
    const models = [project, task({ parents: [{ column: 'project_id', type: 'project' }] })];
    s = await open(harness, world(models, 'assignee', [assignment('a1', alice, 'worker', ref('project', 'p1'))]), 'column-relation-scoped');
    expect(await listed(s, alice, 'task:read')).to.deep.equal(['t1']);
    expect(await authzOf(s).can(alice, 'task:read', await row('t1'))).to.equal(true);
    expect(await authzOf(s).can(alice, 'task:read', await row('t3'))).to.equal(false);
  });

  it('boot refuses a list permission whose relation has no @Relation column', async () => {
    let error: unknown;
    try {
      s = await open(harness, world([task()], 'reviewer'), 'column-relation-missing');
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(AuthzConfigError);
    const message = (error as Error).message;
    expect(message).to.contain('reviewer');
    expect(message).to.contain('listable column relations');
  });
});
