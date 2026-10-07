import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { AuthzConfigError, AuthzContributor, AuthzService } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

import { TELEMETRY_CONFIGURATION_SCHEMA, TelemetryAccessContributor } from '../src/index.js';
import { bootChild, disposeChildren } from './support/child-config.js';

const SLOTS = { a: 'AccessPolicy', b: 'PublicPolicy', c: 'AccessPolicy' };

describe('TelemetryAccessContributor', function () {
  this.timeout(30000);

  let installedHere = false;
  const touched: string[][] = [];
  const set = (path: string, value: unknown) => {
    touched.push(path.split('.'));
    testHost.config().set(path.split('.'), value);
  };

  before(async () => {
    try {
      testHost.config();
    } catch {
      installedHere = true;
      await testHost.installHost();
    }
  });

  afterEach(async () => {
    await disposeChildren();
    await testHost.resetRoot();
    for (const path of touched.splice(0)) testHost.config().unset(path);
  });

  after(async () => {
    if (installedHere) await testHost.uninstallHost();
  });

  const contribute = (domain: string) => new TelemetryAccessContributor().contribute(domain).permissionRefs;

  it("emits every permission of each 'AccessPolicy' slot for the domain the slots check in", () => {
    set('telemetry.auth.domain', 'tel');
    set('telemetry.auth.policies', SLOTS);
    set('telemetry.auth.permissions', { a: 'telemetry:read', b: 'telemetry:read', c: ['telemetry:write', 'logs:read'] });

    expect(contribute('tel')).to.deep.eq([
      { permission: 'telemetry:read', type: 'telemetry', source: 'telemetry.auth.permissions.a' },
      { permission: 'telemetry:write', type: 'telemetry', source: 'telemetry.auth.permissions.c' },
      { permission: 'logs:read', type: 'logs', source: 'telemetry.auth.permissions.c' },
    ]);
    expect(contribute('root')).to.deep.eq([]);
  });

  it('checks in root when telemetry.auth.domain is unset', () => {
    set('telemetry.auth.policies', { a: 'AccessPolicy' });
    set('telemetry.auth.permissions', { a: 'telemetry:read' });

    expect(contribute('root')).to.deep.eq([{ permission: 'telemetry:read', type: 'telemetry', source: 'telemetry.auth.permissions.a' }]);
  });

  it('reads the root configuration when a domain container resolves it, as TelemetryAccessPolicy does', async () => {
    set('telemetry.auth.policies', { a: 'AccessPolicy' });
    set('telemetry.auth.permissions', { a: 'telemetry:read' });
    const { child } = await bootChild({ telemetry: { auth: { domain: 'tel', policies: { b: 'AccessPolicy' }, permissions: { b: 'logs:read' } } } }, TELEMETRY_CONFIGURATION_SCHEMA);

    const contributor = (await child.resolve(Array.chainOf(AuthzContributor))).find((c): c is TelemetryAccessContributor => c instanceof TelemetryAccessContributor)!;

    expect(contributor.contribute('root').permissionRefs).to.deep.eq([{ permission: 'telemetry:read', type: 'telemetry', source: 'telemetry.auth.permissions.a' }]);
    expect(contributor.contribute('tel').permissionRefs).to.deep.eq([]);
  });

  it('is registered as an AuthzContributor by loading the policy module', () => {
    expect(DI.getRegisteredTypes(AuthzContributor) ?? []).to.include(TelemetryAccessContributor);
  });

  describe("fails the domain's boot (B02)", () => {
    it('for a slot permission that is not registered', async () => {
      set('authz.permissions', { 'telemetry:read': {} });
      set('telemetry.auth.policies', { metrics: 'AccessPolicy' });
      set('telemetry.auth.permissions', { metrics: 'telemetry:raed' });

      const err = await (DI.resolve(AuthzService) as Promise<unknown>).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).to.be.instanceOf(AuthzConfigError);
      expect((err as Error).message).to.contain('telemetry:raed').and.contain('telemetry.auth.permissions.metrics');
    });

    it('and boots when every slot permission is registered', async () => {
      set('authz.permissions', { 'telemetry:read': {} });
      set('telemetry.auth.policies', { metrics: 'AccessPolicy' });
      set('telemetry.auth.permissions', { metrics: 'telemetry:read' });

      expect(await DI.resolve(AuthzService)).to.be.instanceOf(AuthzService);
    });
  });
});
