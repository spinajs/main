const HealthResponseSchema = {
  type: 'object',
  description: 'Every field but status is present only for a caller admitted by telemetry.auth.policies.probeDetail',
  properties: {
    status: { type: 'string', enum: ['up'], description: 'Always "up" — this endpoint runs no checks' },
    startedAt: { type: 'number', description: 'Process start, epoch ms' },
    uptimeMs: { type: 'number' },
    pid: { type: 'number' },
    version: { type: 'string', description: 'telemetry.health.version; omitted when unset' },
    node: { type: 'string', description: 'Node runtime version' },
  },
};

export default HealthResponseSchema;
