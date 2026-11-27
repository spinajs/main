import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { GLOBAL } from '@spinajs/authz';
import { DI } from '@spinajs/di';

import { GlobalTeamRootScope, TeamRootScope, TeamService } from '../../src/index.js';
import { teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;

describe('TeamRootScope', function () {
  this.timeout(60000);

  let stack: TeamsStack;
  let teams: TeamService;

  before(async () => {
    stack = await teamsStack();
    teams = await DI.resolve(TeamService);
  });

  afterEach(() => sinon.restore());

  const slug = (s: string) => `${s}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  it('is $global by default', () => {
    expect(DI.resolve(TeamRootScope)).to.be.instanceOf(GlobalTeamRootScope);
    expect(new GlobalTeamRootScope().root()).to.eq(GLOBAL);
    expect(new GlobalTeamRootScope().tenancy).to.eq(false);
  });

  it('is where createTeam checks team:create for a root team', async () => {
    const creator = await teamCreator();
    const root = sinon.spy(GlobalTeamRootScope.prototype, 'root');
    const assert = sinon.spy(stack.authz, 'assert');

    await teams.createTeam(creator, { slug: slug('root-scope'), name: 'Root scope' });

    expect(root.calledOnce).to.eq(true);
    expect(assert.calledWith(creator, 'team:create', sinon.match.same(root.firstCall.returnValue))).to.eq(true);
  });

  it('is where moveTeam checks team:create for a team moved to the root', async () => {
    const creator = await teamCreator();
    const parent = await teams.createTeam(creator, { slug: slug('root-parent'), name: 'Parent' });
    const child = await teams.createTeam(creator, { slug: slug('root-child'), name: 'Child', parentId: parent.id });
    const root = sinon.spy(GlobalTeamRootScope.prototype, 'root');
    const assert = sinon.spy(stack.authz, 'assert');

    expect((await teams.moveTeam(creator, child.id, null)).parentId).to.eq(null);

    expect(root.calledOnce).to.eq(true);
    expect(assert.calledWith(creator, 'team:create', sinon.match.same(root.firstCall.returnValue))).to.eq(true);
  });
});
