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
        },
        required: ["name", "level", "target"],
      },
    },
  },
};

export default CONFIGURATION_SCHEMA;
