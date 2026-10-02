import type { ModelCapabilities } from '@spinajs/authz';

import { cmp, extension, permit, staticModel } from './dsl.js';
import type { OrmModelSpec } from './lane.js';
import { ormWorld } from './B20-orm-scoping.spec.js';
import type { World } from './types.js';

const PROJECT: OrmModelSpec = { name: 'Project', type: 'project', relationScope: 'join', columns: ['status'], rows: [{ id: 'p1', status: 'open' }] };

const world = (sync: ModelCapabilities['sync']): World => ({ ...ormWorld({}, [PROJECT]), models: [staticModel('m1', { capabilities: { sync }, votes: { '*': permit(cmp('status', 'eq', 'open')) } })] });

export const B05Orm = extension('B05', [
  {
    name: 'orm',
    facets: ['engine', 'boot', 'orm'],
    lanes: ['L4'],
    note: "Rule 6 refuses a join-scoped type routed to a model whose residual is not IO-free, but ModelCapabilities says nothing about IO-free residuals, and a sync: 'never' model may have one (ReBAC, design line 1250). So no case here refuses at boot (D-F5-9); the refusal needs a capability and an RFC from L4.",
    cases: [{ name: "rule 6: relationScope 'join' routed to a sync: 'always' model boots", world: world('always'), steps: [{ models: ['m1'] }] }],
  },
]);
