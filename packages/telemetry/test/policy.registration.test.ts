import 'mocha';
import { expect } from 'chai';
import { execFileSync } from 'child_process';
import { join, normalize, resolve } from 'path';

import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';

// Loading the controller modules is what is under test — deliberately NOT the
// package barrel.
import './../src/controllers/Metrics.js';
import './../src/controllers/Telemetry.js';

/**
 * Regression guard for the fail-open hole: the routes name their policies as
 * STRINGS ( `telemetry.auth.policies.*` ), and `@spinajs/http` drops a policy
 * name it cannot resolve — a route left with no policies calls `next()`, so an
 * unregistered policy class serves the endpoint to anyone. Nothing forces the
 * policy modules to load except an import, and the controllers are mounted by a
 * config-declared directory scan that never touches the package barrel.
 */
describe('telemetry policy registration', function () {
  this.timeout(120000);

  it('registers both policies from the controller modules alone', () => {
    expect(DI.checkType(BasePolicy, 'TelemetryTokenPolicy'), 'TelemetryTokenPolicy must be a registered BasePolicy').to.eq(true);
    expect(DI.checkType(BasePolicy, 'PublicPolicy'), 'PublicPolicy must be a registered BasePolicy').to.eq(true);
  });

  it('resolves both policy names to a usable BasePolicy instance', async () => {
    const token = await DI.resolve<BasePolicy>('TelemetryTokenPolicy');
    const pub = await DI.resolve<BasePolicy>('PublicPolicy');

    expect(token).to.be.instanceOf(BasePolicy);
    expect(pub).to.be.instanceOf(BasePolicy);
  });

  /**
   * The assertions above cannot fail in a whole-suite run even if the fix were
   * reverted: other specs import `src/index.js`, whose barrel re-exports the
   * policies, and the module cache is per-process. So the real proof runs in a
   * FRESH process that imports only the controller modules.
   */
  it('registers both policies in a process that never loads the package barrel', () => {
    const probe = resolve(normalize(join(process.cwd(), 'test', 'probe.policy-registration.ts')));

    const out = execFileSync(process.execPath, ['--no-warnings', '--experimental-specifier-resolution=node', '--loader', 'ts-node/esm', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const match = /__PROBE__(.*?)__PROBE__/.exec(out);
    expect(match, `probe produced no result marker, output was: ${out}`).to.not.eq(null);

    const result = JSON.parse(match![1]) as { token: boolean; publicPolicy: boolean; control: boolean };

    // The negative control first: without it a checkType that always returned
    // true would make the two assertions below meaningless.
    expect(result.control, 'an unregistered policy name must report false').to.eq(false);
    expect(result.token, 'TelemetryTokenPolicy must register without the barrel').to.eq(true);
    expect(result.publicPolicy, 'PublicPolicy must register without the barrel').to.eq(true);
  });
});
