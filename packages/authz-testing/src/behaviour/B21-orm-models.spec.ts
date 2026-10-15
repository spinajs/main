import { fixture, ownedRows, permit, relation } from './dsl.js';
import { as, orm } from './lane.js';
import type { OrmModelSpec } from './lane.js';
import { TASK, ormWorld } from './B20-orm-access.spec.js';

/** No @AccessResource. */
const NOTE: OrmModelSpec = {
  name: 'Note',
  columns: ['text'],
  rows: [
    { id: 'n1', text: 'x' },
    { id: 'n2', text: 'y' },
  ],
};
/** A second model of type 'task'. */
const ARCHIVE: OrmModelSpec = {
  ...TASK,
  name: 'TaskArchive',
  rows: [
    { id: 'a1', title: 'old', owner: 'alice' },
    { id: 'a2', title: 'old', owner: 'bob' },
  ],
};

const OWNER = { 'task:read': permit(relation('owner')) };
const OWNER_LIST = { 'task:read': ownedRows() };

export const B21 = fixture('B21', [
  {
    name: 'orm',
    facets: ['engine', 'host', 'orm'],
    lanes: ['L5'],
    cases: [
      {
        name: 'a model without @AccessResource is never checked nor guarded, also without a principal',
        world: ormWorld({}, {}, [TASK, NOTE]),
        steps: [orm({ op: 'select', model: 'Note' }, { ids: ['n1', 'n2'] }), as('alice', orm({ op: 'select', model: 'Note' }, { ids: ['n1', 'n2'] })), { calls: { model: 'm1', count: 0 } }],
      },
      {
        name: 'several models may share a type, each filtered by .accessible() alike',
        world: ormWorld(OWNER, OWNER_LIST, [TASK, ARCHIVE]),
        steps: [as('alice', orm({ op: 'select', model: 'Task', accessible: 'task:read' }, { ids: ['t1', 't3'] }), orm({ op: 'select', model: 'TaskArchive', accessible: 'task:read' }, { ids: ['a1'] }))],
      },
    ],
  },
]);
