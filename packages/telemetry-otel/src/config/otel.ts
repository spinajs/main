const config = {
  otel: {
    /** Master switch — when false nothing is created and tracers are no-ops. */
    enabled: false,

    /** OTLP/HTTP traces endpoint (highlight.io default). */
    endpoint: 'https://otel.highlight.io:4318/v1/traces',

    /** Reported as the OTel `service.name` resource attribute. */
    serviceName: 'spinajs-app',

    /** Extra resource attributes, e.g. { 'highlight.project_id': '...' }. */
    resourceAttributes: {} as Record<string, string>,

    longSpan: {
      /** Spans open longer than this are force-closed as orphaned. */
      maxAgeMs: 30 * 60_000,

      /** Orphan sweep cadence. */
      sweepIntervalMs: 60_000,
    },
  },
};

export default config;
