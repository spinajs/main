import 'mocha';
import { expect } from 'chai';
import { execFileSync } from 'child_process';
import { join, normalize, resolve } from 'path';

// Deliberately not the package barrel.
import '../src/controllers/Metrics.js';
import '../src/controllers/Telemetry.js';

import { DI } from '@spinajs/di';
import { AuthzContributor } from '@spinajs/authz';
import { BasePolicy } from '@spinajs/http';

// Slots name TelemetryTokenPolicy and PublicPolicy as strings. In 3.0 a name that does not resolve
// fails route registration, but only if the module registering it is loaded: the controllers must do that alone.
describe('telemetry policy registration', function () {
  this.timeout(120000);

  it('registers the named policies and the contributor from the controller modules alone', () => {
    expect(DI.checkType(BasePolicy, 'TelemetryTokenPolicy'), 'TelemetryTokenPolicy').to.eq(true);
    expect(DI.checkType(BasePolicy, 'PublicPolicy'), 'PublicPolicy').to.eq(true);
    expect((DI.getRegisteredTypes(AuthzContributor) ?? []).map((t: { name: string }) => t.name)).to.include('TelemetryAccessContributor');
  });

  it('resolves the named policies to a BasePolicy instance', async () => {
    expect(await DI.resolve<BasePolicy>('TelemetryTokenPolicy')).to.be.instanceOf(BasePolicy);
    expect(await DI.resolve<BasePolicy>('PublicPolicy')).to.be.instanceOf(BasePolicy);
  });

  it('registers them in a process that never loads the package barrel', () => {
    const probe = resolve(normalize(join(process.cwd(), 'test', 'support', 'probe.policy-registration.ts')));

    const out = execFileSync(process.execPath, ['--no-warnings', '--experimental-specifier-resolution=node', '--loader', 'ts-node/esm', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const match = /__PROBE__(.*?)__PROBE__/.exec(out);
    expect(match, `probe produced no result marker, output was: ${out}`).to.not.eq(null);

    const result = JSON.parse(match![1]) as { tokenPolicy: boolean; publicPolicy: boolean; contributor: boolean; control: boolean };
    expect(result.control, 'an unregistered policy name must report false').to.eq(false);
    expect(result.tokenPolicy, 'TelemetryTokenPolicy without the barrel').to.eq(true);
    expect(result.publicPolicy, 'PublicPolicy without the barrel').to.eq(true);
    expect(result.contributor, 'TelemetryAccessContributor without the barrel').to.eq(true);
  });
});
