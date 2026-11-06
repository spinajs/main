import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

import { StudioCapabilitiesController } from './Capabilities.js';

/** Mount order is route order: the UI catch-all (sv-08) stays last, after every API route. */
export const STUDIO_CONTROLLERS: Class<BaseController>[] = [StudioCapabilitiesController];

export { StudioCapabilitiesController };
