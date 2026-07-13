/**
 * Default configuration shipped with @spinajs/log ( Node only ).
 *
 * Everything the log package can be tuned with lives here, so the configuration
 * module surfaces a single, discoverable list of what can be changed:
 *
 *  1. a DEFAULT fs provider `fs-log-default` rooted at the working process
 *     directory, so FileTarget works without any user fs configuration,
 *  2. `logger.file` - the default FileTarget options ( buffer / rotation /
 *     retention tunables ). FileTarget merges these UNDER any per-target
 *     `options`, and a user project config ( loaded last ) overrides them - the
 *     same override chain every other spinajs package uses.
 *
 * Config files are merged with array concatenation, so the provider entry is
 * APPENDED to any providers the user configures.
 */

const DEFAULT_FS_PROVIDER = "fs-log-default";

/**
 * Canonical default FileTarget options. This is the SINGLE source of truth for
 * every log tunable - change a default HERE, never inline in the target or a
 * strategy. It is exported ( not just embedded in the config below ) so the
 * FileTarget can fall back to the exact same values when the config file is not
 * discovered ( eg. isolated unit tests ), and so tests share one definition.
 */
export const LOG_FILE_DEFAULTS = {
  /** fs provider holding the active log file. */
  fs: DEFAULT_FS_PROVIDER,

  /** Zip the archived file when it is moved to the archive. */
  compress: false,

  /** Rotate the active log once it grows past this many bytes ( 1 MB ). */
  maxSize: 1024 * 1024,

  /** Flush the in-memory buffer after this many messages. */
  maxBufferSize: 100,

  /** Periodic flush tick in milliseconds, so a partial buffer is not held. */
  flushInterval: 1000,

  /** How often ( seconds ) SizeLogArchiveStrategy checks the active log size. */
  archiveInterval: 60,

  /** Rotation trigger strategy ( decides WHEN to archive ). */
  archiveStrategy: "SizeLogArchiveStrategy",

  /** Retention strategies applied in order after each rotation. */
  retentionStrategies: ["CountLogRetentionStrategy"],

  /** Archives to keep ( CountLogRetentionStrategy ), oldest deleted first. */
  maxArchiveFiles: 5,

  /** Max archive age in seconds ( AgeLogRetentionStrategy ), 7 days. */
  maxAge: 7 * 24 * 60 * 60,
};

const log = {
  fs: {
    defaultProvider: DEFAULT_FS_PROVIDER,
    providers: [
      {
        name: DEFAULT_FS_PROVIDER,
        service: "fsNative",
        basePath: process.cwd(),
      },
    ],
  },
  logger: {
    file: LOG_FILE_DEFAULTS,
  },
};

export default log;
