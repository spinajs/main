import type { BehaviourFixture, FixtureExtension } from './types.js';
import { B06Rules } from './B06-check-filter-rules.spec.js';
import { B11 } from './B11-effective-roles.spec.js';
import { B12 } from './B12-extends.spec.js';
import { B13 } from './B13-scoped-assignments.spec.js';
import { B15 } from './B15-relations.spec.js';
import { B16 } from './B16-resource-patterns.spec.js';
import { B18 } from './B18-abac-targets.spec.js';
import { B19 } from './B19-conditions.spec.js';
import { B26 } from './B26-covers-guard.spec.js';
import { B27Events } from './B27-events.spec.js';
import { B31 } from './B31-ladders.spec.js';
import { B32 } from './B32-implies.spec.js';
import { B33 } from './B33-subject-sets.spec.js';
import { B34 } from './B34-tags-provenance.spec.js';
import { B35 } from './B35-rules.spec.js';
import { B36Rbac } from './B36-deny-reason-rbac.spec.js';
import { B38 } from './B38-links.spec.js';
import { B39Store } from './B39-scope-attributes-store.spec.js';
import { B40 } from './B40-canvas.spec.js';
import { B42 } from './B42-invalid-links.spec.js';
import { B43 } from './B43-authz-admin.spec.js';
import { B44 } from './B44-rules-sql.spec.js';
import { B45 } from './B45-instance-roles.spec.js';
import { B46 } from './B46-external-sharing.spec.js';

/** The model, store and admin fixtures, and their parts for B06, B27, B36 and B39. */
export const MODEL_FIXTURES: readonly (BehaviourFixture | FixtureExtension)[] = Object.freeze([B06Rules, B11, B12, B13, B15, B16, B18, B19, B26, B27Events, B31, B32, B33, B34, B35, B36Rbac, B38, B39Store, B40, B42, B43, B44, B45, B46]);
