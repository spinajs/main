import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzContributor } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { CONFIGURATION_SCHEMA } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { GlobalTeamRootScope, TeamRootScope, TeamsTenancyCheck, checkTeamsTenancy } from '../../src/index.js';

const expect = chai.expect;

class TenantRoot extends TeamRootScope {
  public override readonly tenancy = true;

  public root(): ResourceRef {
    return { type: 'tenant', id: 'acme' };
  }
}

const globalRoot = new GlobalTeamRootScope();
const tenantRoot = new TenantRoot();

describe('teams.tenancy', () => {
  afterEach(() => sinon.restore());

  it('may stay unset while tenancy is not in use', () => {
    expect(() => checkTeamsTenancy(undefined, false, globalRoot)).not.to.throw();
  });

  it('must be set once @spinajs/tenancy or the teams bridge is imported', () => {
    expect(() => checkTeamsTenancy(undefined, true, globalRoot)).to.throw(InvalidOption, 'teams.tenancy must be true or false');
    expect(() => checkTeamsTenancy(undefined, false, tenantRoot)).to.throw(InvalidOption, 'teams.tenancy must be true or false');
  });

  it('must agree with the root scope of the teams', () => {
    expect(() => checkTeamsTenancy(true, true, globalRoot)).to.throw(InvalidOption, 'is not imported');
    expect(() => checkTeamsTenancy(false, true, tenantRoot)).to.throw(InvalidOption, 'is imported');
    expect(() => checkTeamsTenancy('yes', true, tenantRoot)).to.throw(InvalidOption, 'must be true or false');
    expect(() => checkTeamsTenancy(true, true, tenantRoot)).not.to.throw();
    expect(() => checkTeamsTenancy(false, true, globalRoot)).not.to.throw();
  });

  it('is checked by an AuthzContributor that reads the schemas @spinajs/tenancy registers', async () => {
    const contributors = await DI.resolve(Array.ofType(AuthzContributor));
    const check = contributors.find((c) => c instanceof TeamsTenancyCheck);
    expect(check, 'TeamsTenancyCheck is registered').to.be.instanceOf(TeamsTenancyCheck);

    expect(await check?.contribute('root')).to.deep.equal({});

    // What `import '@spinajs/tenancy'` leaves in the root container, without importing it into this process.
    const cache = DI.RootContainer.Cache;
    const read = cache.get.bind(cache);
    sinon.stub(cache, 'get').callsFake((key: Parameters<typeof read>[0], parent?: boolean): unknown => (key === CONFIGURATION_SCHEMA.key ? [{ $configurationModule: 'tenancy' }] : read(key, parent)));
    expect(() => check?.contribute('root')).to.throw(InvalidOption, 'teams.tenancy must be true or false');
  });
});
