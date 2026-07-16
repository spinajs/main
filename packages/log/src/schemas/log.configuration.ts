const CONFIGURATION_SCHEMA = {
  $id: "spinajs/log.configuration.schema.json",
  $configurationModule: "logger",
  description: "Logger configuration option validation",
  type: "object",
  properties: {
    targets: {
      description:
        "Log target, where log messages should be written to, and their options",
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        type: "object",
        properties: {
          layout: {
            type: "string",
          },
          name: {
            type: "string",
          },
          type: {
            type: "string",
          },
          enabled: {
            type: "boolean",
          },
          filters: {
            description:
              "Per-target filter pipeline, applied only when writing to THIS target ( after the logger-level filters ). Each item is { type, ...opts } where `type` is the DI name of a LogFilter. Any returning null drops the entry for this target only.",
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  description: "DI string name of the registered LogFilter.",
                  type: "string",
                },
              },
              required: ["type"],
            },
          },
          // FileTarget options ( nested under `options` )
          options: {
            type: "object",
            properties: {
              path: {
                description:
                  "Active log path, relative to the `fs` provider base path. Variables allowed.",
                type: "string",
              },
              archivePath: {
                description:
                  "Archive directory, relative to the `archiveFs` provider base path. Variables allowed.",
                type: "string",
              },
              fs: {
                description:
                  "Registered @spinajs/fs provider for the active log. Defaults to 'fs-log-default'.",
                type: "string",
              },
              archiveFs: {
                description:
                  "Registered @spinajs/fs provider archives are moved to. Defaults to `fs`.",
                type: "string",
              },
              archiveStrategy: {
                description:
                  "LogArchiveStrategy class name deciding WHEN to rotate. Default 'SizeLogArchiveStrategy'.",
                type: "string",
              },
              retentionStrategies: {
                description:
                  "LogRetentionStrategy class names applied in order after rotation. Default ['CountLogRetentionStrategy'].",
                type: "array",
                items: {
                  type: "string",
                },
              },
              maxSize: {
                description: "Max active log size in bytes before rotation.",
                type: "integer",
                minimum: 1,
              },
              compress: {
                description: "Zip the archived file when moved to the archive.",
                type: "boolean",
              },
              rotate: {
                description:
                  "Cron expression for CronLogArchiveStrategy ( 6-field with seconds ).",
                type: "string",
              },
              maxBufferSize: {
                description: "Max buffered messages before a flush.",
                type: "integer",
                minimum: 1,
              },
              maxQueueSize: {
                description:
                  "Hard cap on buffered messages; oldest are dropped past this so a down sink cannot OOM.",
                type: "integer",
                minimum: 1,
              },
              maxArchiveFiles: {
                description:
                  "How many archives to keep ( CountLogRetentionStrategy ). Oldest are deleted.",
                type: "integer",
                minimum: 1,
              },
              maxAge: {
                description:
                  "Max archive age in seconds ( AgeLogRetentionStrategy ).",
                type: "integer",
                minimum: 1,
              },
              archiveInterval: {
                description:
                  "Interval in seconds SizeLogArchiveStrategy checks the active log size.",
                type: "integer",
                minimum: 1,
              },
              flushInterval: {
                description:
                  "Periodic flush tick in milliseconds for a partially filled buffer.",
                type: "integer",
                minimum: 1,
              },
            },
            required: ["path"],
          },
        },
        required: ["name", "type"],
      },
    },
    file: {
      description:
        "Default FileTarget options ( buffer / rotation / retention tunables ) merged UNDER every file target's own `options`. Shipped by @spinajs/log ( see logger.file defaults ) and overridable by user config.",
      type: "object",
    },
    whenRepeated: {
      description:
        "Opt-in dedup filter. Collapses identical repeated log entries within a timeout window into one, emitting a (xN) count when logging resumes. Off when absent; global for now.",
      type: "object",
      properties: {
        timeout: {
          description:
            "Suppression window in SECONDS. Identical entries within this window are collapsed. Default 10.",
          type: "integer",
          minimum: 1,
        },
        maxKeys: {
          description:
            "Hard cap on tracked keys; the map self-prunes ( expired first, then oldest ) so memory stays bounded. Default 1024.",
          type: "integer",
          minimum: 1,
        },
      },
    },
    filters: {
      description:
        "Composable per-logger filter pipeline. Each item is { type, ...opts } where `type` is the DI name of a LogFilter ( eg. LevelFilter, MatchFilter, RateLimitFilter, WhenRepeatedFilter ). Filters run in order in write(); any returning null drops the entry.",
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            description: "DI string name of the registered LogFilter.",
            type: "string",
          },
        },
        required: ["type"],
      },
    },
    rules: {
      description: "Log rules, what log should be write where",
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
          },
          level: {
            type: "string",
            enum: [
              "trace",
              "debug",
              "warn",
              "info",
              "error",
              "fatal",
              "security",
              "success",
            ],
          },
          maxLevel: {
            description:
              "Optional INCLUSIVE upper bound of the level window this rule routes. With `level` as the lower bound, only entries in [level, maxLevel] are routed. Defaults to the highest level ( security ).",
            type: "string",
            enum: [
              "trace",
              "debug",
              "warn",
              "info",
              "error",
              "fatal",
              "security",
              "success",
            ],
          },
          target: {
            oneOf: [
              {
                type: "string",
              },
              {
                type: "array",
                items: {
                  type: "string",
                },
              },
            ],
          },
          final: {
            description:
              "Stop evaluating further rules for a logger once this matching rule is applied ( NLog-style ). Earlier matched rules and this one still apply.",
            type: "boolean",
          },
        },
        required: ["name", "level", "target"],
      },
    },
  },
};

export default CONFIGURATION_SCHEMA;
