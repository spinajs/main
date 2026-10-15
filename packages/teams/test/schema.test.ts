import * as chai from 'chai';
import 'mocha';

import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';

import { TEAMS_CONFIGURATION_SCHEMA, TEAMS_DEFAULTS } from '../src/index.js';

const expect = chai.expect;

describe('teams configuration schema', () => {
  it('fills the defaults', async () => {
    const { child, configuration } = await bootConfiguration({ teams: { membership: {}, deletion: {}, invitations: {} } }, [TEAMS_CONFIGURATION_SCHEMA]);
    try {
      expect(configuration.get('teams.membership.subTeamsInParent')).to.equal(true);
      expect(configuration.get('teams.deletion.graceDays')).to.equal(30);
      expect(configuration.get('teams.invitations.defaultTtlHours')).to.equal(168);
      expect(configuration.get('teams.invitations.secret')).to.equal(undefined);
    } finally {
      await child.dispose();
    }
    expect(TEAMS_DEFAULTS).to.deep.equal({ subTeamsInParent: true, graceDays: 30, defaultTtlHours: 168, subject: 'You are invited to join a team' });
  });

  it('refuses a short secret, a negative grace and an unknown key', async () => {
    const paths = await violationPaths(bootConfiguration({ teams: { invitations: { secret: 'short' }, deletion: { graceDays: -1 }, membership: { subTeamsInParent: 'yes' } } }, [TEAMS_CONFIGURATION_SCHEMA]));
    expect(paths).to.include('teams.invitations.secret');
    expect(paths).to.include('teams.deletion.graceDays');
    expect(paths).to.include('teams.membership.subTeamsInParent');
  });
});
