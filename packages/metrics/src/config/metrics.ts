
/**
 * 
 * Configuraiton for prom metrics bundle for express
 * https://github.com/jochen-schweizer/express-prom-bundle
 *  
 */
const config = {
    metrics: {
        auth: { 

            // set this in your project
            token: "",
            policy: "DefaultMetricsPolicy"
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
        }
    },
  };
  
  export default config;
  