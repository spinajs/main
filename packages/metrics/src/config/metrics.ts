import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'metrics', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

/**
 *
 * Configuraiton for prom metrics bundle for express
 * https://github.com/jochen-schweizer/express-prom-bundle
 *
 */
const config = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },
  metrics: {
    auth: {
      // set this in your project
      token: '',
      policy: 'DefaultMetricsPolicy',
    },

    /**
     *  * Configuraiton for prom metrics bundle for express
     * https://github.com/jochen-schweizer/express-prom-bundle
     */
    http: {
      includeStatusCode: true,
      includeMethod: true,
      includePath: true,
      // customLabels: "spinajs",
      // includeUp:  true,
      // metricsPath: "/metrics",
      // metricType: "histogram",
      // httpDurationMetricName: 60
    },
  },
};

export default config;
