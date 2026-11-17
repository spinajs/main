import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

import { StudioAuthzController } from './Authz.js';
import { StudioCapabilitiesController } from './Capabilities.js';
import { StudioDiController } from './Di.js';
import { StudioExplainController } from './Explain.js';
import { StudioLogsController } from './Logs.js';
import { StudioRebacController } from './Rebac.js';
import { StudioRoutesController } from './Routes.js';
import { StudioTracesController } from './Traces.js';
import { StudioUiController } from './Ui.js';

/** Mount order is route order: the UI catch-all stays last, or its `*path` would shadow every API route after it. */
export const STUDIO_CONTROLLERS: Class<BaseController>[] = [StudioCapabilitiesController, StudioTracesController, StudioLogsController, StudioDiController, StudioAuthzController, StudioExplainController, StudioRebacController, StudioRoutesController, StudioUiController];

export { StudioAuthzController, StudioCapabilitiesController, StudioDiController, StudioExplainController, StudioLogsController, StudioRebacController, StudioRoutesController, StudioTracesController, StudioUiController };
