// Scheme, host and optional port; no path, query, credentials, wildcard, backslash or space. Consumers still normalise it with
// @spinajs/http's parseOrigin, which also refuses a port above 65535 and a broken IPv6 literal.
const ORIGIN_PATTERN = '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#*@\\\\\\s]+/?$';

/** The authn.http fragment of the authn configuration; `trustProxy` is in the authn schema. */
export const AUTHN_HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-http.configuration.schema.json',
  $configurationModule: 'authn.http',
  description: 'Authentication HTTP layer configuration (authn.http)',
  type: 'object',
  properties: {
    publicOrigin: {
      type: ['string', 'null'],
      pattern: ORIGIN_PATTERN,
      description: "The origin clients put in an HTTP message signature's @target-uri (scheme://host[:port]); never taken from Host. Unset: signed requests get no principal.",
    },
    csrf: {
      type: 'object',
      default: {},
      properties: {
        // Not `type: 'boolean'`: coerceTypes would turn a null into false and switch the guard off.
        enabled: { enum: [true, false], default: true },
        allowedOrigins: { type: 'array', default: [], items: { type: 'string', pattern: ORIGIN_PATTERN }, description: 'Besides the same origin, which is always allowed.' },
      },
    },
    admin: {
      type: 'object',
      properties: {
        basePath: { type: 'string', minLength: 1, description: 'Where the credential admin routes mount, without the global route prefix. Unset: authn/admin/users.' },
      },
    },
    routes: {
      type: 'object',
      properties: {
        prefix: { type: 'string' },
      },
    },
  },
};
