import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
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
      controllers: [dir('./../controllers')],
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
