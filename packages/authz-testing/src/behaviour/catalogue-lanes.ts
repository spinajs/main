import type { BehaviourFixture, FixtureExtension } from './types.js';
import { B02Lanes } from './B02-lanes.spec.js';
import { B07Token } from './B07-token.spec.js';
import { B09Lanes } from './B09-lanes.spec.js';
import { B10 } from './B10-anonymous.spec.js';
import { B17Lanes } from './B17-lanes.spec.js';
import { B20 } from './B20-orm-access.spec.js';
import { B21 } from './B21-orm-models.spec.js';
import { B23 } from './B23-access-policy.spec.js';
import { B24 } from './B24-token-principals.spec.js';
import { B25 } from './B25-access-summary.spec.js';
import { B27Lanes } from './B27-lanes.spec.js';
import { B28 } from './B28-fs-guard.spec.js';
import { B29Fs } from './B29-fs.spec.js';
import { B30 } from './B30-queue.spec.js';
import { B37Token } from './B37-token.spec.js';
import { B41 } from './B41-production.spec.js';

/** Lane fixtures (HTTP, ORM, fs, queue, token, host integration) and the lane parts of rules defined elsewhere. */
export const LANE_FIXTURES: readonly (BehaviourFixture | FixtureExtension)[] = Object.freeze([B02Lanes, B07Token, B09Lanes, B10, B17Lanes, B20, B21, B23, B24, B25, B27Lanes, B28, B29Fs, B30, B37Token, B41]);
