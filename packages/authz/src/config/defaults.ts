import { DEFAULT_COMBINE } from '../engine/routes.js';

export const AUTHZ_DEFAULTS = Object.freeze({
  combine: DEFAULT_COMBINE,
  fields: Object.freeze({ neverRead: Object.freeze(['Password']), write: Object.freeze({ mode: 'strip' as 'strip' | 'reject' }) }),
  engine: Object.freeze({ explain: false, modelTimeoutMs: 2000, maxDelegation: 2 }),
  cache: Object.freeze({ maxEntries: 10000, ttlSeconds: 60 }),
  audit: Object.freeze({ denials: true, runAs: true, unscoped: true }),
  principals: Object.freeze({ anonymous: Object.freeze({ enabled: true }) }),
  config: Object.freeze({ rejectLegacyKeys: false }),
});
