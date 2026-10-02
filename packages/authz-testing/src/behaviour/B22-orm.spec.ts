import type { ModelCapabilities } from '@spinajs/authz';

import { cmp, extension, permit, staticModel } from './dsl.js';
import { as, orm } from './lane.js';
import { TASK, ormWorld } from './B20-orm-scoping.spec.js';
import type { Case, World } from './types.js';

const OPEN = { 'task:read': permit(cmp('status', 'eq', 'open')) };
const select = orm({ op: 'select', model: 'Task' }, { ids: ['t1', 't2'] });

const world = (sync: ModelCapabilities['sync'], delayMs?: number): World => ({
  ...ormWorld(OPEN, [TASK]),
  models: [staticModel('m1', { votes: OPEN, capabilities: { sync }, ...(delayMs ? { delayMs } : {}) })],
});

const cases: Case[] = [
  { name: "sync: 'always' scopes the query", world: world('always'), steps: [as('alice', select)] },
  { name: "sync: 'after-preload' scopes the query after preload", world: world('after-preload'), steps: [{ preload: 'alice' }, as('alice', select)] },
  { name: "sync: 'after-preload' without preload still scopes the query (filterNow undefined, filter awaited)", world: world('after-preload'), steps: [as('alice', select)] },
  { name: 'a model that needs IO (filterNow undefined) scopes the query through the awaited filter', world: world('never', 5), steps: [as('alice', select)] },
];

export const B22Orm = extension('B22', [{ name: 'orm', facets: ['engine', 'host', 'orm'], lanes: ['L4'], note: 'afterQueryCreation uses filterNow; undefined marks the builder, and beforeQueryExecution compiles the awaited filter (design §12.2).', cases }]);
