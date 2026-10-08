import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA, subtractFieldGlobs } from '@spinajs/authz';
import { bindConfiguration, bootConfiguration, testHost, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { PrincipalMiddleware, decisionFields } from '../src/index.js';

describe('authz-http reads the authz section through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const anonymousOf = (child: IContainer) => (bindConfiguration(new PrincipalMiddleware(), child) as unknown as { AnonymousEnabled: boolean }).AnonymousEnabled;

  it('PrincipalMiddleware reads authz.principals.anonymous.enabled of its container, on by default', async () => {
    expect(anonymousOf(await boot({ principals: { anonymous: { enabled: false } } }))).to.equal(false);
    expect(anonymousOf(await boot({}))).to.equal(true);
  });

  it('refuses a malformed authz.principals.anonymous.enabled at boot', async () => {
    expect(await violationPaths(boot({ principals: { anonymous: { enabled: 'yes' } } }))).to.include('authz.principals.anonymous.enabled');
  });

  describe('with the host domains', () => {
    before(async () => {
      await testHost.installHost();
      await testHost.domains();
    });

    after(() => testHost.uninstallHost());

    it('decisionFields merges the authz section it is given over the domain lineage', () => {
      const fields = decisionFields({ fields: { neverRead: ['Secret'], write: { mode: 'reject' } } }, undefined, 'root');

      expect(fields.writeMode).to.equal('reject');
      expect(fields.read).to.deep.equal(subtractFieldGlobs(['*'], ['Secret']));
    });
  });
});
