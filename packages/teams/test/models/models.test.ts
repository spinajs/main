import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { Group, Team } from '../../src/index.js';
import { asSystem } from '../../src/host.js';
import { groupParent, liveGroup, liveTeam, teamLineage } from '../../src/lookup.js';
import { toGroupView, toTeamView } from '../../src/views.js';
import { teamsDb } from '../support/db.js';
import type { TeamsDb } from '../support/db.js';

const expect = chai.expect;

async function team(parentId: string | null = null, extra: Partial<Team> = {}): Promise<Team> {
  const now = DateTime.now();
  const t = new Team({ id: randomUUID(), parent_id: parentId, slug: `t-${randomUUID().slice(0, 8)}`, name: 'T', description: null, archived_at: null, deleted_at: null, created_by: 'user:test', created_at: now, updated_at: now, ...extra });
  await asSystem(() => t.insert());
  return t;
}

async function group(teamId: string, parentId: string | null = null): Promise<Group> {
  const now = DateTime.now();
  const g = new Group({ id: randomUUID(), team_id: teamId, parent_id: parentId, slug: `g-${randomUUID().slice(0, 8)}`, name: 'G', description: null, created_by: 'user:test', created_at: now, updated_at: now });
  await asSystem(() => g.insert());
  return g;
}

describe('Team and Group models', function () {
  let db: TeamsDb;

  before(async () => {
    db = await teamsDb();
  });

  it('keeps the scope tree: sub-team → team, group → team, nested group → group', async () => {
    const root = await team();
    const sub = await team(root.id);
    const outer = await group(sub.id);
    const inner = await group(sub.id, outer.id);
    const above = async (type: string, id: string) => (await db.rows('authz_resource_ancestor', { resource_type: type, resource_id: id })).map((r) => `${String(r.ancestor_type)}:${String(r.ancestor_id)}`);
    expect(await above('team', sub.id)).to.include(`team:${root.id}`);
    expect(await above('group', outer.id)).to.include.members([`team:${sub.id}`, `team:${root.id}`]);
    expect(await above('group', inner.id)).to.include.members([`group:${outer.id}`, `team:${sub.id}`, `team:${root.id}`]);
  });

  it('round-trips rows into frozen views with Dates', async () => {
    const t = await team();
    const view = toTeamView(await liveTeam(t.id));
    expect(view).to.include({ id: t.id, parentId: null, slug: t.slug, name: 'T', description: null, archivedAt: null, deletedAt: null, createdBy: 'user:test' });
    expect(view.createdAt).to.be.instanceOf(Date);
    expect(Object.isFrozen(view)).to.equal(true);
    const g = await group(t.id);
    expect(toGroupView(await liveGroup(g.id))).to.include({ id: g.id, teamId: t.id, parentId: null });
  });

  it('liveTeam and liveGroup hide deleted teams and their groups', async () => {
    const t = await team(null, { deleted_at: DateTime.now() });
    const g = await group(t.id);
    for (const load of [() => liveTeam(t.id), () => liveGroup(g.id), () => liveTeam(randomUUID())]) {
      expect(await load().catch((e: unknown) => e)).to.be.instanceOf(ResourceNotFound);
    }
  });

  it('a group parent must be a live group of the same team', async () => {
    const a = await team();
    const b = await team();
    const ga = await group(a.id);
    const gb = await group(b.id);
    expect((await groupParent(a.id, ga.id)).id).to.equal(ga.id);
    const e = await groupParent(a.id, gb.id).catch((err: unknown) => err);
    expect(e).to.be.instanceOf(InvalidArgument);
    expect((e as InvalidArgument).fieldName).to.equal('parentId');
  });

  it('teamLineage lists a team and its ancestors, nearest first', async () => {
    const root = await team();
    const mid = await team(root.id);
    const leaf = await team(mid.id);
    expect(await teamLineage(leaf.id)).to.deep.equal([leaf.id, mid.id, root.id]);
  });
});
