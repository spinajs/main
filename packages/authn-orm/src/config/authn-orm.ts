// The config loader merges every .js under lib/*/config, so this folder holds this file only (no index barrel).
// With this package installed MemoryAuthnThrottle and DbAuthnThrottle are both registered, and the core refuses to
// pick one by itself; the database throttle is the one a multi-instance app needs. An app that wants the memory
// throttle names it in its own config. DbAuthnAuditSink is not listed in authn.audit.sinks: arrays concatenate across
// config files, so an app could never take it out again, and every registered sink gets every event anyway.
const authnOrm = {
  authn: {
    throttle: {
      service: 'DbAuthnThrottle',
    },
  },
};

export default authnOrm;
