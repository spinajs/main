import 'mocha';
import { expect } from 'chai';

import fragment from '../src/config/telemetry.js';
import { TELEMETRY_CONFIGURATION_SCHEMA, TelemetryAccessContributor } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';

const auth = (value: Record<string, unknown>) => ({ telemetry: { auth: value } });

describe('telemetry.auth configuration', () => {
  afterEach(disposeChildren);

  it('gives an unconfigured app the code defaults', async () => {
    const { config } = await bootChild({}, TELEMETRY_CONFIGURATION_SCHEMA);

    expect(config.get('telemetry.auth')).to.deep.equal({ skipInDevelopment: false, domain: 'root' });
  });

  it('accepts the shipped telemetry configuration', async () => {
    await bootChild({ telemetry: fragment.telemetry }, TELEMETRY_CONFIGURATION_SCHEMA);
  });

  it('accepts a permission or a list of them per endpoint', async () => {
    await bootChild(auth({ policies: { a: 'AccessPolicy', b: 'PublicPolicy' }, permissions: { a: 'telemetry:read', b: ['telemetry:read', 'logs:read'] } }), TELEMETRY_CONFIGURATION_SCHEMA);
  });

  describe('a bad value fails the boot with the full path of the bad key', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['an empty domain', { domain: '' }, 'telemetry.auth.domain'],
      ['a domain that is not a string', { domain: {} }, 'telemetry.auth.domain'],
      ['a skip flag that is not a boolean', { skipInDevelopment: {} }, 'telemetry.auth.skipInDevelopment'],
      ['a token that is not a string', { token: {} }, 'telemetry.auth.token'],
      ['policies that is not a map', { policies: 'AccessPolicy' }, 'telemetry.auth.policies'],
      ['an empty slot', { policies: { metrics: '' } }, 'telemetry.auth.policies.metrics'],
      ['a slot that is not a string', { policies: { metrics: ['AccessPolicy'] } }, 'telemetry.auth.policies.metrics'],
      ['an empty permission', { permissions: { metrics: '' } }, 'telemetry.auth.permissions.metrics'],
      ['an empty permission list', { permissions: { metrics: [] } }, 'telemetry.auth.permissions.metrics'],
      ['a permission without an action', { permissions: { metrics: 'telemetry' } }, 'telemetry.auth.permissions.metrics'],
      ['a list with an invalid permission', { permissions: { metrics: ['telemetry:read', 'read'] } }, 'telemetry.auth.permissions.metrics'],
      ['a permission that is not a string or a list', { permissions: { metrics: {} } }, 'telemetry.auth.permissions.metrics'],
    ];

    for (const [label, value, path] of cases) {
      it(`for ${label}`, async () => {
        expect(await violationPaths(auth(value), TELEMETRY_CONFIGURATION_SCHEMA)).to.include(path);
      });
    }
  });

  describe('TelemetryAccessContributor reads the configuration of the container that builds it', () => {
    const values = auth({ domain: 'tel', policies: { a: 'AccessPolicy', b: 'PublicPolicy', c: 'AccessPolicy' }, permissions: { a: 'telemetry:read', b: 'telemetry:read', c: ['telemetry:write', 'logs:read'] } });

    it("emits the permissions of each 'AccessPolicy' slot for the domain the slots check in", async () => {
      const { child } = await bootChild(values, TELEMETRY_CONFIGURATION_SCHEMA);
      const contributor = await child.resolve(TelemetryAccessContributor);

      expect(contributor.contribute('tel').permissionRefs).to.deep.eq([
        { permission: 'telemetry:read', type: 'telemetry', source: 'telemetry.auth.permissions.a' },
        { permission: 'telemetry:write', type: 'telemetry', source: 'telemetry.auth.permissions.c' },
        { permission: 'logs:read', type: 'logs', source: 'telemetry.auth.permissions.c' },
      ]);
      expect(contributor.contribute('root').permissionRefs).to.deep.eq([]);
    });

    it('checks in root when telemetry.auth.domain is not configured', async () => {
      const { child } = await bootChild(auth({ policies: { a: 'AccessPolicy' }, permissions: { a: 'telemetry:read' } }), TELEMETRY_CONFIGURATION_SCHEMA);
      const contributor = await child.resolve(TelemetryAccessContributor);

      expect(contributor.contribute('root').permissionRefs).to.deep.eq([{ permission: 'telemetry:read', type: 'telemetry', source: 'telemetry.auth.permissions.a' }]);
    });
  });
});
