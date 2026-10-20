import 'mocha';
import { expect } from 'chai';
import { bindConfiguration, bootConfiguration, testHost } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';

import { AccessPolicy, ServicePrincipalSource } from '../src/index.js';
import { ExplainControllerSource } from '../src/explain/source.js';
import { servicePrincipals } from '../src/http-config.js';

describe('authz-http floors for values the schema never saw', () => {
  let child: IContainer | undefined;

  afterEach(async () => {
    await child?.dispose();
    child = undefined;
  });

  it('does not mount the explain route for a non-boolean switch', async () => {
    for (const enabled of ['false', '0', 1]) {
      const booted = await bootConfiguration({ configuration: { isProduction: false } });
      child = booted.child;
      booted.configuration.set(['authz', 'http', 'explainRoute', 'enabled'], enabled);
      const source = bindConfiguration(new ExplainControllerSource(), child);

      expect(await source.getControllers(), String(enabled)).to.deep.eq([]);
      await child.dispose();
      child = undefined;
    }
  });

  it('authenticates no service, rather than throwing, without authz.http.services', async () => {
    const booted = await bootConfiguration({});
    child = booted.child;
    booted.configuration.set(['authz', 'http', 'services'], undefined);
    const source = bindConfiguration(new ServicePrincipalSource(), child);

    expect(await source.authenticate({ headers: { 'x-a': 't' } } as never)).to.equal(null);
  });

  it('skips a nameless service entry', () => {
    const entry = { header: 'X-A', token: 't' };
    const kept = servicePrincipals([entry, { ...entry, name: '' }, { ...entry, name: 'ok' }] as never);

    expect(kept.map((s) => s.name)).to.deep.eq(['ok']);
  });

  describe('with the host domains', () => {
    before(async () => {
      await testHost.installHost();
      await testHost.domains();
    });

    after(() => testHost.uninstallHost());

    it('leaves a denial a denial when authz.http.explainRoute.permission is unset', async () => {
      const policy = Object.create(AccessPolicy.prototype) as AccessPolicy;
      Object.defineProperties(policy, { IsProduction: { value: false }, ExplainPermission: { value: undefined }, Authz: { value: { engine: { explain: true } } } });
      const authz = { check: () => Promise.reject(new Error('unreachable')) };

      const trace = await (policy as unknown as { trace(...a: unknown[]): Promise<unknown> }).trace(authz, 'root', { type: 'user', id: 'a' } as Principal, {});

      expect(trace).to.equal(undefined);
    });

    it('gives no trace while engine.explain is anything but true', async () => {
      const authz = { check: async () => ({ allowed: true, residual: { op: 'true' } }), explain: async () => ({ trace: 'TRACE' }) };
      const traceWith = async (explain: unknown) => {
        const policy = Object.create(AccessPolicy.prototype) as AccessPolicy;
        Object.defineProperties(policy, { IsProduction: { value: false }, ExplainPermission: { value: 'authz:explain' }, Authz: { value: { engine: { explain } } } });
        return (policy as unknown as { trace(...a: unknown[]): Promise<unknown> }).trace(authz, 'root', { type: 'user', id: 'a' } as Principal, {});
      };

      expect(await traceWith(true)).to.equal('TRACE');
      for (const explain of ['false', 'true', 1, {}]) expect(await traceWith(explain), JSON.stringify(explain)).to.equal(undefined);
    });
  });
});
