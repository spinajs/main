export const HOOKS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/hooks.configuration.schema.json',
  $configurationModule: 'hooks',
  description: 'Action hooks configuration (hooks.*)',
  type: 'object',
  // propertyNames rejects a typo; additionalProperties: false would let removeAdditional drop it silently.
  propertyNames: { enum: ['timeoutMs', 'maxDepth'] },
  properties: {
    timeoutMs: { type: 'integer', minimum: 1, maximum: 60000, default: 5000, description: 'Bound per hook call, in milliseconds.' },
    maxDepth: { type: 'integer', minimum: 1, maximum: 32, default: 8, description: 'Nested action runs; past it a run throws ActionHookFailed with reason depth.' },
  },
};
