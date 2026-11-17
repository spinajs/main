import type { Class } from '@spinajs/di';

import { TraceStore } from './buffers/trace-store.js';

/** Singletons StudioControllerSource resolves before Studio mounts; each later task adds its stores here. */
export const STUDIO_SERVICES: Class<unknown>[] = [TraceStore];
