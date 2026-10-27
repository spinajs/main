import type { DoctorRule } from '../index.js';
import { unresolvedInjection } from './unresolved-injection.js';
import { diCycle } from './di-cycle.js';
import { asyncIntoSync } from './async-into-sync.js';
import { duplicateRoute } from './duplicate-route.js';
import { routeWithoutPolicy } from './route-without-policy.js';
import { configUsageWithoutSchema } from './config-usage-without-schema.js';
import { dirsMissing } from './dirs-missing.js';
import { conditionUnmet } from './condition-unmet.js';
import { fragmentStale } from './fragment-stale.js';
import { modelsWithoutAccessResource } from './models-without-access-resource.js';
import { explicitSchemaDrift } from './explicit-schema-drift.js';

export const DEFAULT_RULES: DoctorRule[] = [
  unresolvedInjection,
  diCycle,
  asyncIntoSync,
  duplicateRoute,
  routeWithoutPolicy,
  configUsageWithoutSchema,
  dirsMissing,
  conditionUnmet,
  fragmentStale,
  modelsWithoutAccessResource,
  explicitSchemaDrift,
];

export {
  unresolvedInjection,
  diCycle,
  asyncIntoSync,
  duplicateRoute,
  routeWithoutPolicy,
  configUsageWithoutSchema,
  dirsMissing,
  conditionUnmet,
  fragmentStale,
  modelsWithoutAccessResource,
  explicitSchemaDrift,
};
