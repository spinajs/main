/**
 * The metric abstraction lives in `@spinajs/telemetry-common`, which depends on nothing but
 * `@spinajs/di` and prom-client.
 *
 * It was extracted for one reason: `@spinajs/orm` publishes connection-pool telemetry, and this
 * package depends on `@spinajs/http`, `@spinajs/log`, `@spinajs/validation` and
 * `@spinajs/configuration`. An ORM that depended on `@spinajs/telemetry` would put the whole HTTP
 * stack underneath every database connection. Same reason `@spinajs/configuration-common` and
 * `@spinajs/log-common` exist.
 *
 * Re-exported here so `import { Metrics } from '@spinajs/telemetry'` keeps working, and so both
 * packages share ONE `Metrics` class identity — DI resolves the singleton by that identity, and a
 * second copy would mean a second, separate registry.
 */
export * from '@spinajs/telemetry-common';
