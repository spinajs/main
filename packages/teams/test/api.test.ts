import * as chai from 'chai';
import 'mocha';

import { Forbidden } from '@spinajs/exceptions';

import * as teams from '../src/index.js';

const expect = chai.expect;

describe('teams api', () => {
  it('names the types, roles and event the package is built on', () => {
    expect(teams.TEAM_TYPE).to.equal('team');
    expect(teams.GROUP_TYPE).to.equal('group');
    expect(teams.TEAM_MEMBER_ROLE).to.equal('team.member');
    expect(teams.TEAM_OWNER_ROLE).to.equal('team.owner');
    expect(teams.TEAM_ADMIN_ROLE).to.equal('team.admin');
    expect(teams.GROUP_MEMBER_ROLE).to.equal('group.member');
    expect(teams.TEAM_PURGED_EVENT).to.equal('TeamPurged');
  });

  it('exports the service contracts as abstract DI tokens', () => {
    for (const token of [teams.TeamService, teams.GroupService, teams.InvitationService, teams.InvitationMailer, teams.VerifiedEmailSource]) {
      expect(token).to.be.a('function');
    }
  });

  it('InvitationRefused is a Forbidden carrying a stable, enumerable code', () => {
    const e = new teams.InvitationRefused('expired');
    expect(e).to.be.instanceOf(Forbidden);
    expect(e.code).to.equal('expired');
    expect(Object.keys(e)).to.include('code');
    expect(e.message).to.match(/expired/);
    expect(teams.INVITATION_REFUSALS).to.deep.equal(['unknown', 'revoked', 'expired', 'used_up', 'email_mismatch', 'not_a_user', 'inviter_lost_authority']);
  });
});
