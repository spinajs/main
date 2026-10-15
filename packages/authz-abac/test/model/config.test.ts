import 'mocha';
import { expect } from 'chai';
import { AuthzConfigError } from '@spinajs/authz';
import { bootConfiguration, fakeModelInitContext, violationPaths } from '@spinajs/authz-testing';
import type { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_ABAC_CONFIGURATION_SCHEMA, AbacConfigBootstrapper, storesFromConfig } from '../../src/index.js';

describe('authz.abac configuration schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(abac: unknown): Promise<Configuration> {
    const booted = await bootConfiguration({ authz: { abac } }, [AUTHZ_ABAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  const refused = (abac: unknown) => violationPaths(boot(abac));

  it('fills the defaults storesFromConfig reads', async () => {
    expect((await boot(undefined)).get('authz.abac')).to.deep.equal({ stores: ['ConfigPolicyStore'], policies: [], connection: 'default' });
  });

  it('a validated authz.abac builds its stores', async () => {
    const configuration = await boot({ stores: ['ConfigPolicyStore', 'DbPolicyStore'], connection: 'abac' });
    const ctx = fakeModelInitContext({ config: configuration.get<Record<string, unknown>>('authz.abac') });

    expect(storesFromConfig('abac', ctx).map((s) => s.constructor.name)).to.deep.equal(['ConfigPolicyStore', 'DbPolicyStore']);
  });

  it('refuses at boot what storesFromConfig and ConfigPolicyStore refused at init', async () => {
    expect(await refused({ stores: 'ConfigPolicyStore' })).to.include('authz.abac.stores');
    expect(await refused({ stores: ['Nope'] })).to.include('authz.abac.stores.0');
    expect(await refused({ policies: {} })).to.include('authz.abac.policies');
    expect(await refused({ policies: ['x'] })).to.include('authz.abac.policies.0');
    expect(await refused({ connection: '' })).to.include('authz.abac.connection');
  });

  it('fails closed with a named error for stores or policies an unvalidated configuration holds as no list', () => {
    for (const [config, path] of [
      [{ stores: 'ConfigPolicyStore' }, 'authz.abac.stores'],
      [{ stores: null }, 'authz.abac.stores'],
      [{ policies: 'p' }, 'authz.abac.policies'],
      [{ policies: {} }, 'authz.abac.policies'],
    ] as const) {
      expect(() => storesFromConfig('abac', fakeModelInitContext({ config })), JSON.stringify(config)).to.throw(AuthzConfigError, path);
    }
  });

  it('the bootstrapper registers the schema', () => {
    const KEY = '__configurationSchema__';
    const had = DI.RootContainer.Cache.has(KEY);
    new AbacConfigBootstrapper().bootstrap();
    try {
      expect(DI.RootContainer.Cache.get(KEY)).to.include(AUTHZ_ABAC_CONFIGURATION_SCHEMA);
    } finally {
      const list = DI.RootContainer.Cache.get(KEY) as unknown[];
      list.splice(list.indexOf(AUTHZ_ABAC_CONFIGURATION_SCHEMA), 1);
      if (!had && list.length === 0) DI.uncache(KEY);
    }
  });
});
