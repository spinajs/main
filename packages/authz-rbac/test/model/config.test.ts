import * as chai from 'chai';
import 'mocha';
import { bootConfiguration, fakeModelInitContext, violationPaths } from '@spinajs/authz-testing';
import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, DEFAULT_ASSIGNMENTS_TTL_SECONDS, DEFAULT_GROUP_PRINCIPAL, DEFAULT_MAX_CACHED_SUBJECTS, DEFAULT_ROLES_CHECK_SECONDS, groupPrincipalConfig } from '../../src/index.js';

const expect = chai.expect;

describe('authz-rbac model configuration through the schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(rbac: unknown): Promise<Configuration> {
    const booted = await bootConfiguration({ authz: { rbac } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  const refused = (rbac: unknown) => violationPaths(boot(rbac));

  it('fills the defaults the model reads, from the same constants', async () => {
    const configuration = await boot(undefined);

    expect(configuration.get('authz.rbac.cache')).to.deep.equal({ assignmentsTtlSeconds: DEFAULT_ASSIGNMENTS_TTL_SECONDS, maxSubjects: DEFAULT_MAX_CACHED_SUBJECTS, rolesCheckSeconds: DEFAULT_ROLES_CHECK_SECONDS });
    expect(configuration.get('authz.rbac.groupPrincipal')).to.deep.equal(DEFAULT_GROUP_PRINCIPAL);
    expect(configuration.get('authz.rbac.anonymousRoles')).to.deep.equal([]);
    expect(configuration.get('authz.rbac.serviceRoles')).to.deep.equal({});
  });

  it('takes a partial or a null groupPrincipal, as groupPrincipalConfig reads it', async () => {
    expect((await boot({ groupPrincipal: { role: 'team' } })).get('authz.rbac.groupPrincipal')).to.deep.equal({ role: 'team', scopeType: 'group' });
    const off = (await boot({ groupPrincipal: null })).get('authz.rbac.groupPrincipal');
    expect(off).to.equal(null);
    expect(groupPrincipalConfig(fakeModelInitContext({ model: 'rbac', config: { groupPrincipal: off } }))).to.equal(null);
  });

  it('takes a rolesCheckSeconds of 0 (no periodic role check), but not a null that coercion would turn into 0', async () => {
    expect((await boot({ cache: { rolesCheckSeconds: 0 } })).get('authz.rbac.cache.rolesCheckSeconds')).to.equal(0);
    expect(await refused({ cache: { rolesCheckSeconds: null } })).to.include('authz.rbac.cache.rolesCheckSeconds');
  });

  it('refuses at boot what the model refused at init', async () => {
    expect(await refused({ anonymousRoles: 'guest' })).to.include('authz.rbac.anonymousRoles');
    expect(await refused({ serviceRoles: { 'service:x': 'telemetry' } })).to.include('authz.rbac.serviceRoles.service:x');
    expect(await refused({ cache: { assignmentsTtlSeconds: -1 } })).to.include('authz.rbac.cache.assignmentsTtlSeconds');
    expect(await refused({ cache: { maxSubjects: 1.5 } })).to.include('authz.rbac.cache.maxSubjects');
    expect(await refused({ cache: { rolesCheckSeconds: -1 } })).to.include('authz.rbac.cache.rolesCheckSeconds');
    expect(await refused({ cache: { rolesCheckSeconds: null } })).to.include('authz.rbac.cache.rolesCheckSeconds');
    expect(await refused({ groupPrincipal: { role: '' } })).to.include('authz.rbac.groupPrincipal.role');
    expect(await refused({ groupPrincipal: 'group.member' })).to.include('authz.rbac.groupPrincipal');
    expect(await refused({ groupPrincipal: { name: 'x' } })).to.include('authz.rbac.groupPrincipal.name');
  });
});
