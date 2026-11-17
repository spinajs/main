import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

import { StudioAuthzController } from './Authz.js';
import { StudioCapabilitiesController } from './Capabilities.js';
import { StudioDiController } from './Di.js';
import { StudioExplainController } from './Explain.js';
import { StudioLogsController } from './Logs.js';
import { StudioTracesController } from './Traces.js';

/** Mount order is route order: the UI catch-all (sv-08) stays last, after every API route. */
export const STUDIO_CONTROLLERS: Class<BaseController>[] = [StudioCapabilitiesController, StudioTracesController, StudioLogsController, StudioDiController, StudioAuthzController, StudioExplainController];

export { StudioAuthzController, StudioCapabilitiesController, StudioDiController, StudioExplainController, StudioLogsController, StudioTracesController };
