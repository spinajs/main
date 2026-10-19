import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA, AuthzConfigError, AuthzDomains, authzStorage, subtractFieldGlobs } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';
import { bindConfiguration, bootConfiguration, testHost, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import type { IRouteParameter } from '@spinajs/http';

import { AuthzInputFieldFilter, PrincipalMiddleware, decisionFields } from '../src/index.js';

/** An AuthzDomains that is not the host's: it cannot tell a domain's config lineage. */
class ForeignDomains extends AuthzDomains {
  create(): IContainer {
    throw new Error('not used');
  }
  container(): IContainer {
    throw new Error('not used');
  }
  service(): Promise<AuthzService> {
    throw new Error('not used');
  }
  names(): readonly string[] {
    return ['root'];
  }
}

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

    it('decisionFields merges the authz section it is given over the domain lineage', async () => {
      const fields = decisionFields({ fields: { neverRead: ['Secret'], write: { mode: 'reject' } } }, await testHost.domains(), undefined, 'root');

      expect(fields.writeMode).to.equal('reject');
      expect(fields.read).to.deep.equal(subtractFieldGlobs(['*'], ['Secret']));
    });
  });

  describe('without the host domains', () => {
    const authz = { fields: { neverRead: ['Secret'] } };

    it('decisionFields refuses instead of falling back to the default fields.neverRead', () => {
      expect(() => decisionFields(authz, new ForeignDomains(), undefined, 'root')).to.throw(AuthzConfigError, /host AuthzDomains/);
    });

    it('the input filter refuses a body instead of letting the configured fields.neverRead through', () => {
      const filter = Object.defineProperties(new AuthzInputFieldFilter(), { Authz: { value: authz }, Domains: { value: new ForeignDomains() } });
      const parameter = { Type: 'FromBody', Name: 'body' } as unknown as IRouteParameter;

      expect(() => authzStorage().run({ AuthzHttpRoute: { domain: 'root' } }, () => filter.filter({ name: 'n', Secret: 's' }, parameter))).to.throw(AuthzConfigError);
    });
  });
});
