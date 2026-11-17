import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

import { StudioCapabilitiesController } from './Capabilities.js';
import { StudioLogsController } from './Logs.js';
import { StudioTracesController } from './Traces.js';

/** Mount order is route order: the UI catch-all (sv-08) stays last, after every API route. */
export const STUDIO_CONTROLLERS: Class<BaseController>[] = [StudioCapabilitiesController, StudioTracesController, StudioLogsController];

export { StudioCapabilitiesController, StudioLogsController, StudioTracesController };
