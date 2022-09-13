const CONFIGURATION_SCHEMA = {
  $id: "spinajs/log.configuration.schema.json",
  $configurationModule: "logger",
  description: "Logger configuration option validation",
  type: "object",
  properties: {
    targets: {
      description: "Log target, where log messages should be written to, and their options",
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
          path: {
            type: "string",
          },
          archivePath: {
            type: "string",
          },
          maxSize: {
            type: "integer",
            minimum: 10000,
          },
          compress: {
            type: "boolean",
          },
          rotate: {
            type: "string",
          },
          maxArchiveFiles: {
            type: "integer",
            minimum: 1,
          },
          bufferSize: {
            type: "integer",
            minimum: 1000,
          },
        },
        required: ["name", "type"],
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
            enum: ["trace", "debug", "warn", "info", "error", "fatal", "security", "success"],
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
