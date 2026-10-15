import 'mocha';
import { expect } from 'chai';

import { GLOBAL, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import { anonymousPrincipal, fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession } from '@spinajs/authz-testing';

import { E2E_DIALECTS, e2eDb, e2eHarness, withPostgres } from './support/stack.js';
import { NOW, agrees, authzOf, open, stackWorld } from './support/world.js';

const { assignment, ref } = fixtureDsl;
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');
const ALL = ['t1', 't2', 't3', 't4', 't5'];
const P1_TASKS = ['t1', 't2', 't3', 't5'];
const HOUR = 3_600_000;

for (const kind of E2E_DIALECTS) {
  describe(`e2e scenarios (${kind})`, function () {
    this.timeout(120_000);
    const harness = e2eHarness(kind);
    let s: HarnessSession | undefined;

    before(async function () {
      await withPostgres(this, kind);
      await harness.beforeAll?.();
    });
    after(() => harness.afterAll?.());
    afterEach(async () => {
      await s?.dispose();
      s = undefined;
    });

    it('a direct grant on a row lists that row', async () => {
      s = await open(harness, stackWorld([assignment('a1', alice, 'viewer', ref('task', 't2'))]), 'direct');
      await agrees(s, alice, 'task:read', ['t2']);
      await agrees(s, alice, 'task:update', []);
    });

    it('a grant on an ancestor lists its subtree, through nested folders', async () => {
      s = await open(harness, stackWorld([assignment('a1', alice, 'viewer', ref('folder', 'f2')), assignment('a2', bob, 'viewer', ref('project', 'p1')), assignment('a3', carol, 'viewer', ref('org', 'o1'))]), 'ancestor');
      await agrees(s, alice, 'task:read', ['t2', 't3', 't5']);
      await agrees(s, alice, 'folder:read', ['f2', 'f3'], 'Folder', 'folder');
      await agrees(s, bob, 'task:read', P1_TASKS);
      await agrees(s, carol, 'task:read', ALL);
      await agrees(s, carol, 'project:read', ['p1', 'p2'], 'Project', 'project');
    });

    it('a team grant reaches a member through three nested sets, and leaves with the membership', async () => {
      s = await open(harness, stackWorld(), 'teams');
      const admin = authzOf(s).admin();
      const team = (id: string) => ({ role: 'team.member', scope: { type: 'team', id } });
      const results = await admin.execute(SYSTEM, [
        { kind: 'assignment.grant', subject: { set: team('t2') }, role: 'team.member', scope: { type: 'team', id: 't1' } },
        { kind: 'assignment.grant', subject: { set: team('t3') }, role: 'team.member', scope: { type: 'team', id: 't2' } },
        { kind: 'set.addMember', set: team('t3'), member: { type: 'user', id: 'alice' } },
        { kind: 'assignment.grant', subject: { set: team('t1') }, role: 'editor', scope: { type: 'project', id: 'p2' } },
      ]);
      expect(results.every((r) => r.ok), JSON.stringify(results)).to.equal(true);
      await agrees(s, alice, 'task:read', ['t4']);
      await agrees(s, alice, 'task:update', ['t4']);
      await agrees(s, bob, 'task:read', []);

      const [removed] = await admin.execute(SYSTEM, [{ kind: 'set.removeMember', set: team('t3'), member: { type: 'user', id: 'alice' } }]);
      expect(removed.ok).to.equal(true);
      await agrees(s, alice, 'task:read', []);
    });

    it('user:* reaches every user, and not an anonymous caller', async () => {
      s = await open(harness, stackWorld([assignment('a1', { type: 'user', id: '*' }, 'viewer', ref('folder', 'f4'))]), 'wildcard');
      for (const who of [alice, bob, dave]) await agrees(s, who, 'task:read', ['t4']);
      await agrees(s, anonymousPrincipal(), 'task:read', []);
    });

    it('a deny role at a folder overrides an editor role at its project, there and below', async () => {
      s = await open(harness, stackWorld([assignment('a1', carol, 'editor', ref('project', 'p1')), assignment('a2', carol, 'blocked', ref('folder', 'f2'))]), 'deny');
      await agrees(s, carol, 'task:read', ['t1']);
      await agrees(s, carol, 'task:update', ['t1']);
      const [d] = await authzOf(s).checkAll(carol, [{ permission: 'task:update', resource: ref('task', 't3') }]);
      expect(d.reason?.code).to.equal('role_denied');
    });

    it('an expired assignment grants nothing; a live one with an expiry grants until then', async () => {
      s = await open(
        harness,
        stackWorld([assignment('a1', alice, 'viewer', ref('project', 'p1'), { expiresAt: new Date(NOW.getTime() - HOUR) }), assignment('a2', bob, 'viewer', ref('project', 'p2'), { expiresAt: new Date(NOW.getTime() + HOUR) })]),
        'expiry',
      );
      await agrees(s, alice, 'task:read', []);
      await agrees(s, bob, 'task:read', ['t4']);
    });

    it('owner: a grant on the owner relation lists the rows whose @Owner column holds the principal; a deny still wins', async () => {
      s = await open(harness, stackWorld([assignment('a1', bob, 'author', GLOBAL), assignment('a2', alice, 'author', GLOBAL), assignment('a3', alice, 'blocked', ref('folder', 'f3'))]), 'owner');
      await agrees(s, bob, 'task:read', ['t2', 't4']);
      await agrees(s, alice, 'task:read', ['t1']);
    });

    it('ceilings narrow: token roles drop a role, a resource ceiling keeps one subtree', async () => {
      s = await open(harness, stackWorld([assignment('a1', alice, 'viewer', ref('org', 'o1')), assignment('a2', alice, 'editor', ref('org', 'o1'))]), 'ceiling');
      await agrees(s, alice, 'task:update', ALL);
      const viewerOnly = userPrincipal('alice', { ceiling: { roles: ['viewer'] } });
      await agrees(s, viewerOnly, 'task:read', ALL);
      await agrees(s, viewerOnly, 'task:update', []);
      const withinF2 = userPrincipal('alice', { ceiling: { resources: [ref('folder', 'f2')] } });
      await agrees(s, withinF2, 'task:read', ['t2', 't3', 't5']);
      await agrees(s, withinF2, 'task:update', ['t2', 't3', 't5']);
    });

    it('a move (reparent) changes access at once, for the moved subtree', async () => {
      s = await open(harness, stackWorld([assignment('a1', alice, 'viewer', ref('folder', 'f1'))]), 'move');
      await agrees(s, alice, 'task:read', P1_TASKS);
      const Folder = harness.model('Folder') as unknown as { update(v: unknown): any };
      const Task = harness.model('Task') as unknown as { update(v: unknown): any };
      await runWithPrincipal(SYSTEM, async () => {
        await Folder.update({ parent_id: null }).where('id', 'f2');
        await Task.update({ folder_id: 'f1' }).where('id', 't4');
      });
      await agrees(s, alice, 'task:read', ['t1', 't4']);
      const ancestors = await e2eDb().raw(`SELECT ancestor_type, ancestor_id FROM authz_resource_ancestor WHERE resource_type = 'task' AND resource_id = 't3' ORDER BY depth`, [], kind);
      expect(ancestors.map((r: { ancestor_type: string; ancestor_id: string }) => `${r.ancestor_type}:${r.ancestor_id}`)).to.deep.equal(['folder:f3', 'folder:f2', 'project:p1', 'org:o1']);
    });

    it('deleting a resource drops its grants and ancestor links, so a reused id inherits nothing', async () => {
      s = await open(harness, stackWorld(), 'delete');
      const [granted] = await authzOf(s).admin().execute(SYSTEM, [{ kind: 'assignment.grant', subject: { type: 'user', id: 'bob' }, role: 'editor', scope: ref('project', 'p2') }]);
      expect(granted.ok).to.equal(true);
      await agrees(s, bob, 'task:read', ['t4']);

      const Project = harness.model('Project') as unknown as { destroy(pk: unknown): any; insert(v: unknown): any };
      await runWithPrincipal(SYSTEM, async () => void (await Project.destroy('p2')));

      const count = async (sql: string) => Number(((await e2eDb().raw(sql, [], kind)) as { n: number | string }[])[0].n);
      expect(await count(`SELECT COUNT(*) AS n FROM authz_assignment WHERE scope_type = 'project' AND scope_id = 'p2'`)).to.equal(0);
      expect(await count(`SELECT COUNT(*) AS n FROM authz_resource_ancestor WHERE ancestor_type = 'project' AND ancestor_id = 'p2'`)).to.equal(0);
      expect(await count(`SELECT COUNT(*) AS n FROM authz_resource_ancestor WHERE resource_type = 'project' AND resource_id = 'p2'`)).to.equal(0);
      await agrees(s, bob, 'task:read', []);

      await runWithPrincipal(SYSTEM, async () => void (await Project.insert({ id: 'p2', org_id: 'o1' })));
      await agrees(s, bob, 'task:read', []);
    });
  });
}
