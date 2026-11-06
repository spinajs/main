import type { Class } from '@spinajs/di';

/** Singletons StudioControllerSource resolves before Studio mounts; each later task adds its stores here. */
export const STUDIO_SERVICES: Class<unknown>[] = [];
