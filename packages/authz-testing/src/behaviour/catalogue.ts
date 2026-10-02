import type { BehaviourFixture, FixtureExtension } from './types.js';
import { B01 } from './B01-no-permit.spec.js';
import { B02 } from './B02-unregistered-permission.spec.js';
import { B03 } from './B03-combining.spec.js';
import { B04 } from './B04-indeterminate.spec.js';
import { B05 } from './B05-boot-checks.spec.js';
import { B06 } from './B06-check-filter.spec.js';
import { B07 } from './B07-ceiling.spec.js';
import { B08 } from './B08-intersect.spec.js';
import { B09 } from './B09-unattended-system.spec.js';
import { B14 } from './B14-expiry-cache.spec.js';
import { B17 } from './B17-fields.spec.js';
import { B22 } from './B22-filter-now.spec.js';
import { B27 } from './B27-change-bus.spec.js';
import { B29 } from './B29-domains.spec.js';
import { B36 } from './B36-deny-reason.spec.js';
import { B37 } from './B37-inherit.spec.js';
import { B39 } from './B39-scope-attributes.spec.js';

/** Every fixture and extension file of the kit; a new file adds one import and one entry here. */
export const BEHAVIOUR_FIXTURES: readonly (BehaviourFixture | FixtureExtension)[] = Object.freeze([B01, B02, B03, B04, B05, B06, B07, B08, B09, B14, B17, B22, B27, B29, B36, B37, B39]);
