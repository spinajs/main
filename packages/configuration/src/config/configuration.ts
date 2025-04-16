const config = {
  configuration: {
    isDevelopment: process.env.NODE_ENV === 'development',
    isProduction: process.env.NODE_ENV === 'production',
    isLocal : process.env.NODE_ENV === 'local'
  },

  app: {
    name: "spinajs",
    version: "1.0.0"
  }
};

export default config;
