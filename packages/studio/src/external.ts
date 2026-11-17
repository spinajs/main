import { DI } from '@spinajs/di';

import { TraceStore } from './buffers/trace-store.js';
import { StudioSpanProcessor } from './processor.js';

/** For an app whose own OpenTelemetry SDK owns tracing (`owner: 'external'`): add this processor to that SDK. */
export function studioSpanProcessor(): StudioSpanProcessor {
  return new StudioSpanProcessor(() => DI.get(TraceStore) ?? undefined);
}
