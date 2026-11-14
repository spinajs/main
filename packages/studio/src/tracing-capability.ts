import type { StudioCapabilities } from './contracts/index.js';

export function tracingCapability(): StudioCapabilities['tracing'] {
  return { owner: 'none', recording: false };
}
