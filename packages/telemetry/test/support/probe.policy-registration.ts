// Runs in a fresh node process (see policy-registration.test.ts): any other spec
// loads src/index.js, so only a child process can prove the controller modules
// register their policies alone.
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { AuthzContributor } from '@spinajs/authz';

import '../../src/controllers/Metrics.js';
import '../../src/controllers/Telemetry.js';

const registered = (DI.getRegisteredTypes(AuthzContributor) ?? []) as Array<{ name: string }>;

const result = {
  tokenPolicy: DI.checkType(BasePolicy, 'TelemetryTokenPolicy'),
  publicPolicy: DI.checkType(BasePolicy, 'PublicPolicy'),
  contributor: registered.some((t) => t.name === 'TelemetryAccessContributor'),
  control: DI.checkType(BasePolicy, 'NoSuchPolicyExists'),
};

process.stdout.write(`__PROBE__${JSON.stringify(result)}__PROBE__`);
