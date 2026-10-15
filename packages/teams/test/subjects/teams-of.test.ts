import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { SYSTEM } from '@spinajs/authz';
import { DateTime } from 'luxon';

import { Group, Team } from '../../src/index.js';
import { asSystem, execute } from '../../src/host.js';
import { principalTeams } from '../../src/membership.js';
import { groupRef, teamRef } from '../../src/refs.js';
import { groupSet, teamSet } from '../../src/subjects.js';
import { person, refOf } from '../support/people.js';
import { teamsStack } from '../support/stack.js';

const expect = chai.expect;

async function team(name: string, parentId: string | null = null): Promise<Team> {
  const now = DateTime.now();
  const t = new Team({ id: randomUUID(), parent_id: parentId, slug: `t-${randomUUID().slice(0, 8)}`, name, description: null, archived_at: null, deleted_at: null, created_by: null, created_at: now, updated_at: now });
  await asSystem(() => t.insert());
  return t;
}

async function group(name: string, teamId: string, parentId: string | null = null): Promise<Group> {
  const now = DateTime.now();
  const g = new Group({ id: randomUUID(), team_id: teamId, parent_id: parentId, slug: `g-${randomUUID().slice(0, 8)}`, name, description: null, created_by: null, created_at: now, updated_at: now });
  await asSystem(() => g.insert());
  return g;
}

describe('teamsOf', function () {
  before(async () => {
    await teamsStack();
  });

  it('lists the teams and groups a principal belongs to, through nested sets, with the roles held at each', async () => {
    const top = await team('Top');
    const sub = await team('Sub', top.id);
    const outer = await group('Outer', sub.id);
    const inner = await group('Inner', sub.id, outer.id);
    const u = person('u');
    const a = person('a');
    const v = person('v');
    await execute(
      SYSTEM,
      [
        { kind: 'assignment.grant', subject: teamSet(sub.id), role: 'team.member', scope: teamRef(top.id) },
        { kind: 'assignment.grant', subject: groupSet(outer.id), role: 'team.member', scope: teamRef(sub.id) },
        { kind: 'assignment.grant', subject: groupSet(inner.id), role: 'group.member', scope: groupRef(outer.id) },
        { kind: 'set.addMember', set: { role: 'group.member', scope: groupRef(inner.id) }, member: refOf(u) },
        { kind: 'assignment.grant', subject: refOf(a), role: 'team.admin', scope: teamRef(sub.id) },
      ],
      'test: teamsOf world',
    );

    const of = await principalTeams(refOf(u));
    expect(of.teams.map((t) => [t.name, t.roles])).to.deep.equal([
      ['Sub', ['team.member']],
      ['Top', ['team.member']],
    ]);
    expect(of.groups.map((g) => [g.name, g.roles])).to.deep.equal([
      ['Inner', ['group.member']],
      ['Outer', ['group.member']],
    ]);
    expect(Object.isFrozen(of)).to.equal(true);

    const admin = await principalTeams(refOf(a));
    expect(admin.teams.map((t) => [t.name, t.roles])).to.deep.equal([
      ['Sub', ['team.admin']],
      ['Top', ['team.member']],
    ]);
    expect(admin.groups).to.deep.equal([]);

    expect(await principalTeams(refOf(v))).to.deep.equal({ teams: [], groups: [] });

    await asSystem(() => top.update({ deleted_at: DateTime.now() }));
    expect((await principalTeams(refOf(u))).teams.map((t) => t.name)).to.deep.equal(['Sub']);
  });
});
