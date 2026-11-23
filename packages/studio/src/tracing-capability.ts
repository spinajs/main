import { tracingState } from '@spinajs/tracing';

import type { StudioCapabilities } from './contracts/index.js';

export function tracingCapability(): StudioCapabilities['tracing'] {
  const state = tracingState();
  return { owner: state.owner, recording: (state.hub?.size ?? 0) > 0 };
}
