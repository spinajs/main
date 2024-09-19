const config = {
  configuration: {
    isDevelopment: process.env.NODE_ENV === 'development',
    isProduction: process.env.NODE_ENV === 'production',
  },

  app: {
    name: "spinajs",
    version: "1.0.0"
  }
};

export default config;
