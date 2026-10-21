// Scheme, host and optional port; no path, query, credentials, wildcard, backslash or space. Consumers still normalise it with
// @spinajs/http's parseOrigin, which also refuses a port above 65535 and a broken IPv6 literal.
const ORIGIN_PATTERN = '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#*@\\\\\\s]+/?$';

/** What `POST /auth/logout` sends in `Clear-Site-Data` unless `authn.http.logout.clearSiteData` says otherwise. */
export const DEFAULT_LOGOUT_CLEAR_SITE_DATA: readonly string[] = Object.freeze(['cache', 'cookies', 'storage']);

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
      description: 'Deprecated aliases of http.csrf.*, removed in the next major.',
      properties: {
        // Not `type: 'boolean'`: coerceTypes would turn a null into false and switch the guard off.
        enabled: { enum: [true, false], default: true, description: 'Deprecated: http.csrf.enabled. false here or there switches the guard off.' },
        allowedOrigins: { type: 'array', default: [], items: { type: 'string', pattern: ORIGIN_PATTERN }, description: 'Deprecated: http.csrf.allowedOrigins. Both lists count.' },
        unauthenticatedRoutes: {
          type: 'array',
          items: { type: 'string', pattern: '^/' },
          description: 'Deprecated and ignored: every unsafe request a browser sends is checked now.',
        },
      },
    },
    registration: {
      type: 'object',
      default: {},
      properties: {
        notifyExisting: { enum: [true, false], default: true, description: 'POST /auth/register mails the owner of a taken address that someone tried to register with it (purpose account-exists).' },
      },
    },
    admin: {
      type: 'object',
      properties: {
        basePath: { type: 'string', minLength: 1, description: 'Where the credential admin routes mount, without the global route prefix. Unset: authn/admin/users.' },
      },
    },
    logout: {
      type: 'object',
      properties: {
        clearSiteData: {
          type: 'array',
          uniqueItems: true,
          items: { enum: ['cache', 'cookies', 'storage', 'executionContexts', '*'] },
          default: [...DEFAULT_LOGOUT_CLEAR_SITE_DATA],
          description: 'The Clear-Site-Data directives of POST /auth/logout; [] sends no header. "storage" also clears what the app keeps in the browser across sessions.',
        },
      },
    },
  },
};
