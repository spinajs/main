import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'telemetry', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

/**
 * Duration histogram bucket boundaries ( ms ) for http request timing. Kept in
 * sync with DURATION_BUCKETS_MS in middleware.ts, which is the compile-time
 * default when no configuration is present.
 */
const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const config = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },

  telemetry: {
    auth: {
      // set this in your project
      token: '',

      /**
       * Policy class name per endpoint. Each route resolves its policy by
       * reading the config key below, so access can be tightened or loosened
       * per endpoint without touching code.
       */
      policies: {
        metrics: 'TelemetryTokenPolicy',
        stats: 'TelemetryTokenPolicy',
        timeline: 'TelemetryTokenPolicy',
        routes: 'TelemetryTokenPolicy',
        perf: 'TelemetryTokenPolicy',

        // probe endpoints must be reachable without credentials
        health: 'PublicPolicy',
        ready: 'PublicPolicy',
      },
    },

    /**
     * Register prom-client's process / heap / cpu / event-loop metrics against
     * the private registry at bootstrap.
     */
    collectDefaultMetrics: true,

    /** Metric name prefix for the http telemetry metrics. */
    prefix: 'http',

    /** Duration histogram buckets in ms. */
    buckets: DURATION_BUCKETS_MS,

    /** Apdex satisfied threshold in ms; tolerated is 4x this. */
    apdexThresholdMs: 25,

    timeline: {
      /** Number of buckets retained in the ring. */
      length: 60,
      /** Bucket width in ms. */
      bucketMs: 60_000,
    },

    routes: {
      enabled: true,
      /** Cap on distinct method+route keys held in memory. */
      maxEntries: 500,
    },

    perf: {
      enabled: true,
      /** Cap on distinct perf measurement names held in memory. */
      maxNames: 200,
    },

    health: {
      /** Per-check timeout in ms. A timed-out check counts as down. */
      timeoutMs: 2000,
      /** When true a degraded overall status returns 503 rather than 200. */
      failOnDegraded: false,
      /** Reported by /telemetry/health. Omitted from the response when unset. */
      version: undefined as string | undefined,
    },
  },
};

export default config;
