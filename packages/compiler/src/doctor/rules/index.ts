import type { DoctorRule } from '../rule.js';
import { unresolvedInjection } from './unresolved-injection.js';
import { diCycle } from './di-cycle.js';
import { asyncIntoSync } from './async-into-sync.js';
import { duplicateRoute } from './duplicate-route.js';
import { routeWithoutPolicy } from './route-without-policy.js';
import { publicContradictsGuard } from './public-contradicts-guard.js';
import { doubleSlashPath } from './double-slash-path.js';
import { shadowedRoute } from './shadowed-route.js';
import { ambiguousBody } from './ambiguous-body.js';
import { pageWithoutParam } from './page-without-param.js';
import { configUsageWithoutSchema } from './config-usage-without-schema.js';
import { dirsMissing } from './dirs-missing.js';
import { conditionUnmet } from './condition-unmet.js';
import { unknownRouteMiddleware } from './unknown-route-middleware.js';
import { fragmentStale } from './fragment-stale.js';
import { modelsWithoutAccessResource } from './models-without-access-resource.js';
import { explicitSchemaDrift } from './explicit-schema-drift.js';
import { socketContract } from './socket-contract.js';
import { socketWithoutPolicy } from './socket-without-policy.js';
import { handlerWithoutPolicy } from './handler-without-policy.js';
import { unknownPermission } from './unknown-permission.js';
import { resourceMismatch } from './resource-mismatch.js';
import { fieldsWithoutFilter } from './fields-without-filter.js';
import { systemWithoutReason } from './system-without-reason.js';
import { flowSystemWithoutReason, flowUnscopedRead, flowUnscopedWrite } from './flow-findings.js';
import { workflowDuplicateVersion } from './workflow-duplicate-version.js';
import { workflowSignalWithoutAuthorizer } from './workflow-signal-without-authorizer.js';
import { workflowTooManyVersions } from './workflow-too-many-versions.js';
import { sqlAmbiguousColumn, sqlDynamic, sqlInsertValueCount, sqlNoDialect, sqlParseError, sqlRowMismatch, sqlUnknownColumn, sqlUnknownTable } from './sql-queries.js';

export const DEFAULT_RULES: DoctorRule[] = [
  unresolvedInjection,
  diCycle,
  asyncIntoSync,
  duplicateRoute,
  routeWithoutPolicy,
  publicContradictsGuard,
  doubleSlashPath,
  shadowedRoute,
  ambiguousBody,
  pageWithoutParam,
  configUsageWithoutSchema,
  dirsMissing,
  conditionUnmet,
  unknownRouteMiddleware,
  fragmentStale,
  modelsWithoutAccessResource,
  explicitSchemaDrift,
  socketContract,
  socketWithoutPolicy,
  handlerWithoutPolicy,
  unknownPermission,
  resourceMismatch,
  fieldsWithoutFilter,
  systemWithoutReason,
  flowUnscopedRead,
  flowUnscopedWrite,
  flowSystemWithoutReason,
  workflowDuplicateVersion,
  workflowSignalWithoutAuthorizer,
  workflowTooManyVersions,
  sqlParseError,
  sqlUnknownTable,
  sqlUnknownColumn,
  sqlAmbiguousColumn,
  sqlRowMismatch,
  sqlInsertValueCount,
  sqlDynamic,
  sqlNoDialect,
];

export {
  unresolvedInjection,
  diCycle,
  asyncIntoSync,
  duplicateRoute,
  routeWithoutPolicy,
  publicContradictsGuard,
  doubleSlashPath,
  shadowedRoute,
  ambiguousBody,
  pageWithoutParam,
  configUsageWithoutSchema,
  dirsMissing,
  conditionUnmet,
  unknownRouteMiddleware,
  fragmentStale,
  modelsWithoutAccessResource,
  explicitSchemaDrift,
  socketContract,
  socketWithoutPolicy,
  handlerWithoutPolicy,
  unknownPermission,
  resourceMismatch,
  fieldsWithoutFilter,
  systemWithoutReason,
  flowUnscopedRead,
  flowUnscopedWrite,
  flowSystemWithoutReason,
  workflowDuplicateVersion,
  workflowSignalWithoutAuthorizer,
  workflowTooManyVersions,
  sqlParseError,
  sqlUnknownTable,
  sqlUnknownColumn,
  sqlAmbiguousColumn,
  sqlRowMismatch,
  sqlInsertValueCount,
  sqlDynamic,
  sqlNoDialect,
};
