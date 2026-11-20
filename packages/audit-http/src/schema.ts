import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

import { MAX_ABORT_WAIT_MS } from './options.js';

const names = { type: 'array', items: { type: 'string', minLength: 1 } };

// propertyNames, not additionalProperties: the configuration's removeAdditional would drop a misspelt key silently
const KEYS = ['methods', 'redact', 'includeBody', 'maxBodyBytes', 'trail', 'action', 'abortWaitMs', 'rules'];

// No defaults: the middleware lays the options of each mount over audit.http, and a default here would read as a configured value.
export const AUDIT_HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/audit.http.configuration.schema.json',
  $configurationModule: 'audit.http',
  description: 'The Audit route middleware of @spinajs/audit-http, mounted with @Middleware(Audit) or http.routes.middlewares. @Middleware(Audit, options) overrides these per mount; its redact list adds to this one.',
  type: 'object',
  propertyNames: { enum: KEYS },
  properties: {
    methods: { ...names, description: 'HTTP methods audited, eg. ["POST", "PUT", "PATCH", "DELETE"]; unset audits every method.' },
    redact: { ...names, description: 'Keys whose values are recorded as [redacted], matched as case-insensitive substrings at any depth of the body and the query. Replaces the default list.' },
    includeBody: { type: 'boolean' },
    maxBodyBytes: { type: 'integer', minimum: 0, description: 'A larger body, as JSON after redaction, is left out and only its size recorded. Default 16384.' },
    trail: { type: 'string', minLength: 1, description: 'The audit trail the events are written to (audit.trails.<name>). Default "default".' },
    action: { type: 'string', minLength: 1, description: 'A prefix for the action of every route: <action>.<method name>. Unset, the action is the route name.' },
    abortWaitMs: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_ABORT_WAIT_MS,
      description: 'How long the event of a request the client went away from waits for the action to end; past it, or when the server begins to close, the outcome is "attempt". Default 30000.',
    },
    rules: {
      type: 'array',
      description: 'Per-route action and trail where Audit is mounted: the first entry whose match fits the mounted path wins. A rule does not mount Audit.',
      items: {
        type: 'object',
        propertyNames: { enum: ['match', 'action', 'trail'] },
        required: ['match'],
        properties: { match: { type: 'string', minLength: 3 }, action: { type: 'string', minLength: 1 }, trail: { type: 'string', minLength: 1 } },
      },
    },
  },
};

registerConfigurationSchemaAtImport(AUDIT_HTTP_CONFIGURATION_SCHEMA);
