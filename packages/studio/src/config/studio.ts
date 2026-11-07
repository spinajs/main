const config = {
  studio: {
    enabled: false,
    allowProduction: false,
    path: '/_studio',
    ui: {} as { path?: string },
    buffers: { traces: 1000, spansPerTrace: 2000, logs: 5000, slowQueries: 200 },
    captureBindings: false,
    redactAttributes: ['http.request.header.authorization', 'http.request.header.cookie'],
    auth: {
      /** The authz domain the 'AccessPolicy' slots check in. */
      domain: 'root',
      /** Skip the 'AccessPolicy' slot checks while the configured env names development and isProduction is not true. */
      skipInDevelopment: false,
      /** Per endpoint: 'AccessPolicy' checks `permissions.<endpoint>`; any other value names a registered BasePolicy. */
      policies: {
        capabilities: 'AccessPolicy',
        traces: 'AccessPolicy',
        logs: 'AccessPolicy',
        queries: 'AccessPolicy',
        di: 'AccessPolicy',
        routes: 'AccessPolicy',
        authz: 'AccessPolicy',
        explain: 'AccessPolicy',
        ui: 'AccessPolicy',
      },
      /** A permission, or a list of which any one admits, per 'AccessPolicy' endpoint. */
      permissions: {
        capabilities: 'studio:read',
        traces: 'studio:read',
        logs: 'studio:read',
        queries: 'studio:read',
        di: 'studio:read',
        routes: 'studio:read',
        authz: 'studio:read',
        explain: 'studio:explain',
        ui: 'studio:read',
      },
    },
  },

  authz: {
    permissions: {
      'studio:read': { description: 'Open Spina Studio: traces, logs, slow queries, the DI graph, routes and the authz model' },
      'studio:explain': { description: 'Run authz explain from Spina Studio (authz:explain is checked too)' },
    },
    // Unread unless the app loads @spinajs/authz-rbac.
    rbac: {
      roles: {
        studio: { description: 'Reads Spina Studio', grants: ['studio:read'] },
        'studio.explain': { description: 'Reads Spina Studio and runs explain', extends: ['studio'], grants: ['studio:explain'] },
      },
    },
  },
};

export default config;
