import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const names = { type: 'array', items: { type: 'string', minLength: 1 } };

// No defaults: the middleware lays the options of each mount over audit.http, and a default here would read as a configured value.
export const AUDIT_HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/audit.http.configuration.schema.json',
  $configurationModule: 'audit.http',
  description: 'The Audit route middleware of @spinajs/audit-http, mounted with @Middleware(Audit) or http.routes.middlewares. @Middleware(Audit, options) overrides these per mount; its redact list adds to this one.',
  type: 'object',
  additionalProperties: false,
  properties: {
    methods: { ...names, description: 'HTTP methods audited, eg. ["POST", "PUT", "PATCH", "DELETE"]; unset audits every method.' },
    redact: { ...names, description: 'Keys whose values are recorded as [redacted], matched as case-insensitive substrings at any depth of the body and the query. Replaces the default list.' },
    includeBody: { type: 'boolean' },
    maxBodyBytes: { type: 'integer', minimum: 0, description: 'A larger body, as JSON after redaction, is left out and only its size recorded. Default 16384.' },
    trail: { type: 'string', minLength: 1, description: 'The audit trail the events are written to (audit.trails.<name>). Default "default".' },
    action: { type: 'string', minLength: 1, description: 'A prefix for the action of every route: <action>.<method name>. Unset, the action is the route name.' },
    rules: {
      type: 'array',
      description: 'Per-route action and trail where Audit is mounted: the first entry whose match fits the mounted path wins. A rule does not mount Audit.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['match'],
        properties: { match: { type: 'string', minLength: 3 }, action: { type: 'string', minLength: 1 }, trail: { type: 'string', minLength: 1 } },
      },
    },
  },
};

registerConfigurationSchemaAtImport(AUDIT_HTTP_CONFIGURATION_SCHEMA);
