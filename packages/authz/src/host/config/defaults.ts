import { ENGINE_DEFAULTS } from '../../engine/defaults.js';
import { DEFAULT_COMBINE } from '../../engine/routes.js';

/** The config keys naming the DecisionAudit and ChangeBus class a domain picks. */
export const AUTHZ_AUDIT_SERVICE_KEY = 'authz.audit.service';
export const AUTHZ_BUS_SERVICE_KEY = 'authz.bus.service';
export const AUTHZ_DECISION_LOG_SERVICE_KEY = 'authz.decisionLog.service';

const { explain, modelTimeoutMs, maxDelegation, neverRead, cacheMaxEntries, cacheTtlSeconds, auditDenials } = ENGINE_DEFAULTS;

const DECISION_LOG_MODE: 'off' | 'deny' | 'sampled' | 'all' = 'deny';

/** The schema's root-level defaults, and the base every domain merges over (a Configuration that skips the schema starts from these). */
export const AUTHZ_DEFAULTS = Object.freeze({
  combine: DEFAULT_COMBINE,
  fields: Object.freeze({ neverRead, write: Object.freeze({ mode: 'strip' as 'strip' | 'reject' }) }),
  engine: Object.freeze({ explain, modelTimeoutMs, maxDelegation }),
  cache: Object.freeze({ maxEntries: cacheMaxEntries, ttlSeconds: cacheTtlSeconds }),
  audit: Object.freeze({ denials: auditDenials, runAs: true, unscoped: true }),
  principals: Object.freeze({ anonymous: Object.freeze({ enabled: true }) }),
  hooks: Object.freeze({ check: false }),
  decisionLog: Object.freeze({ mode: DECISION_LOG_MODE, allowSampleRate: 0.01, batch: Object.freeze({ size: 100, flushMs: 1000 }) }),
});
