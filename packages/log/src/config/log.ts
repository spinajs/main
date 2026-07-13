/**
 * Default configuration shipped with @spinajs/log ( Node only ).
 *
 * Registers a DEFAULT fs provider `fs-log-default` rooted at the working
 * process directory so FileTarget works without any user fs configuration.
 *
 * Config files are merged with array concatenation, so this provider entry is
 * APPENDED to any providers the user configures. `defaultProvider` is only a
 * fallback - a user project config ( loaded last ) overrides it.
 */
const log = {
  fs: {
    defaultProvider: "fs-log-default",
    providers: [
      {
        name: "fs-log-default",
        service: "fsNative",
        basePath: process.cwd(),
      },
    ],
  },
};

export default log;
