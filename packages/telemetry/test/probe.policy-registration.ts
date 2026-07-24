/**
 * Child-process probe for the policy-registration regression test.
 *
 * NOT a mocha spec ( the runner globs `test/*.test.ts` ) — it is executed in a
 * FRESH node process by `policy.registration.test.ts`, which is the only way to
 * prove the without-the-barrel case: every other spec in the suite imports
 * `src/index.js`, and once any of them has been loaded the module cache has
 * already run the policies' `@Injectable` decorators, so an in-process
 * assertion could never fail.
 *
 * It imports ONLY the two controller modules — exactly what the config-declared
 * directory scan loads in a real app — and reports whether the policy names the
 * routes reference as strings resolve to a registered `BasePolicy`. `control` is
 * the negative case that gives the assertions teeth: an unregistered name must
 * come back false through the very same call http makes.
 */
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';

// The whole point of the probe: no `./../src/index.js` here.
import './../src/controllers/Metrics.js';
import './../src/controllers/Telemetry.js';

const result = {
  token: DI.checkType(BasePolicy, 'TelemetryTokenPolicy'),
  publicPolicy: DI.checkType(BasePolicy, 'PublicPolicy'),
  control: DI.checkType(BasePolicy, 'NoSuchPolicyExists'),
};

process.stdout.write(`__PROBE__${JSON.stringify(result)}__PROBE__`);
