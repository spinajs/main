const HealthResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['up'], description: 'Always "up" — this endpoint runs no checks' },
    startedAt: { type: 'number', description: 'Process start, epoch ms' },
    uptimeMs: { type: 'number' },
    pid: { type: 'number' },
    version: { type: 'string', description: 'telemetry.health.version; omitted when unset' },
    node: { type: 'string', description: 'Node runtime version' },
    manifest: {
      type: 'object',
      description: 'The manifest the app booted from',
      required: ['mode', 'hash'],
      properties: {
        mode: { type: 'string', enum: ['off', 'prefer', 'require'], description: 'Effective system.manifest.mode' },
        hash: { type: 'string', nullable: true, description: 'The manifest hash, as in app.manifest.json and spinajs manifest:diff; null when the app booted without a manifest' },
      },
    },
  },
};

export default HealthResponseSchema;
