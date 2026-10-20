import * as chai from 'chai';
import 'mocha';

import { GLOBAL } from '@spinajs/authz';
import { RoleStore } from '@spinajs/authz-rbac';
import { DI } from '@spinajs/di';

import teamsConfig from '../../src/config/teams.js';
import { person, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;

describe('teams config fragment', function () {
  let stack: TeamsStack;

  before(async () => {
    stack = await teamsStack();
  });

  it('registers every teams permission with the types it is checked on; reads are list permissions', () => {
    const p = teamsConfig.authz.permissions;
    expect(Object.keys(p).sort()).to.deep.equal(['group:create', 'group:delete', 'group:members.manage', 'group:read', 'group:update', 'team:archive', 'team:create', 'team:delete', 'team:invitations.manage', 'team:members.manage', 'team:ownership.transfer', 'team:read', 'team:roles.manage', 'team:update'].sort());
    expect(p['team:read']).to.include({ list: true });
    expect(p['group:read']).to.include({ list: true });
    expect(p['group:create'].types).to.deep.equal(['group', 'team']);
    // Every permission checked at a ref of another type declares that type (the engine refuses it otherwise).
    expect(p['team:roles.manage'].types).to.include('group');
    expect(p['team:create'].types).to.deep.equal(['team']);
    expect(p['team:roles.manage'].types).to.deep.equal(['team', 'group']);
  });

  it('ships the roles of teams §4, one owner per team, and the archived deny policy', () => {
    const { rbac, abac, admin } = teamsConfig.authz;
    expect(rbac.ladders.team).to.deep.equal({ roles: ['team.member', 'team.admin', 'team.owner'] });
    expect(Object.keys(rbac.roles)).to.deep.equal(['team.member', 'team.admin', 'team.owner', 'group.member', 'group.manager']);
    expect(rbac.roles['team.member']).to.include({ subjectSet: true, ladder: 'team' });
    expect(rbac.roles['group.member']).to.include({ subjectSet: true });
    expect(admin.guard.keepHolders).to.deep.equal([{ role: 'team.owner', scopeType: 'team' }]);
    expect(abac.policies.map((p) => [p.id, p.permissions, p.resourceTypes])).to.deep.equal([
      ['teams.archived.write', ['*:create', '*:update'], ['team', 'group']],
      ['teams.archived.delete', ['*:delete'], ['group']],
    ]);
    for (const p of abac.policies) expect(p).to.deep.include({ effect: 'deny', when: { attr: 'scope.team.archived', eq: true } });
  });

  it('boots a domain with the fragment: boot rule 12 accepts team:read and group:read', async () => {
    const stranger = person('stranger');
    for (const permission of ['team:read', 'group:read']) {
      const plan = await stack.authz.accessPlan(stranger, permission, permission.split(':')[0]);
      expect(['none', 'filter']).to.include(plan.kind);
    }
    const roles = await ((await DI.RootContainer.resolve(RoleStore)) as RoleStore).load();
    expect(roles.roles.map((r) => r.name)).to.include.members(['team.member', 'team.admin', 'team.owner', 'group.member', 'group.manager']);
  });

  it('team:create at $global comes from an app role (the test stack ships teams.creator)', async () => {
    const creator = await teamCreator();
    expect(await stack.authz.can(creator, 'team:create', GLOBAL)).to.equal(true);
    expect(await stack.authz.can(person('stranger'), 'team:create', GLOBAL)).to.equal(false);
  });
});
