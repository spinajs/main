/** The engine's built-in values for every option a caller leaves out; the host config defaults are built from these. */
export const ENGINE_DEFAULTS = Object.freeze({
  modelTimeoutMs: 2000,
  maxDelegation: 2,
  neverRead: Object.freeze(['Password']) as readonly string[],
  explain: false,
  cacheTtlSeconds: 60,
  cacheMaxEntries: 10000,
  auditDenials: true,
});
