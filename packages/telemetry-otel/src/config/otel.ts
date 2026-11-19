const config = {
  otel: {
    /** Master switch — when false nothing is created and tracers are no-ops. */
    enabled: false,

    /** OTLP/HTTP traces endpoint (highlight.io default). */
    endpoint: 'https://otel.highlight.io:4318/v1/traces',

    longSpan: {
      /** Spans open longer than this are force-closed as orphaned. */
      maxAgeMs: 30 * 60_000,

      /** Orphan sweep cadence. */
      sweepIntervalMs: 60_000,
    },
  },
};

export default config;
