import type { StudioCapabilities } from '../api/types';

export const capabilities: StudioCapabilities = {
  version: '4.0.0',
  manifest: { loaded: true, hash: 'abc123', mode: 'prefer' },
  tracing: { owner: 'spinajs', recording: true },
  features: { traces: true, logs: true, slowQueries: true, di: true, routes: true, authz: true, rebac: true, telemetry: true, scheduler: true },
  permissions: ['studio:read', 'studio:explain'],
};

export const withFeatures = (features: Partial<StudioCapabilities['features']>, overrides: Partial<StudioCapabilities> = {}): StudioCapabilities => ({
  ...capabilities,
  ...overrides,
  features: { ...capabilities.features, ...features },
});
