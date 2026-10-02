import { cmp, fixture, permit, relation } from './dsl.js';
import { as, orm } from './lane.js';
import type { OrmModelSpec } from './lane.js';
import { TASK, ormWorld } from './B20-orm-scoping.spec.js';

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
    { id: 'a1', title: 'old', status: 'closed', owner: 'alice', team: 'red', visibility: 'private' },
    { id: 'a2', title: 'old', status: 'closed', owner: 'bob', team: 'blue', visibility: 'private' },
  ],
};
const TAG: OrmModelSpec = {
  name: 'Tag',
  type: 'tag',
  columns: ['visibility'],
  rows: [
    { id: 'g1', visibility: 'public' },
    { id: 'g2', visibility: 'private' },
  ],
};
const POST: OrmModelSpec = {
  name: 'Post',
  type: 'post',
  columns: ['title'],
  rows: [{ id: 'p1', title: 'p' }],
  junctions: [
    {
      name: 'tags',
      target: 'Tag',
      pairs: [
        ['p1', 'g1'],
        ['p1', 'g2'],
      ],
    },
  ],
};

const OWNER = permit(relation('owner'));

export const B21 = fixture('B21', [
  {
    name: 'orm',
    facets: ['engine', 'host', 'orm'],
    lanes: ['L4'],
    cases: [
      {
        name: 'a model without @AccessResource is never checked, also without a principal',
        world: ormWorld({}, [TASK, NOTE]),
        steps: [orm({ op: 'select', model: 'Note' }, { ids: ['n1', 'n2'] }), as('alice', orm({ op: 'select', model: 'Note' }, { ids: ['n1', 'n2'] })), { calls: { model: 'm1', count: 0 } }],
      },
      {
        name: 'several models may share a type, each scoped by the residual of the type',
        world: ormWorld({ 'task:read': OWNER }, [TASK, ARCHIVE]),
        steps: [as('alice', orm({ op: 'select', model: 'Task' }, { ids: ['t1', 't3'] }), orm({ op: 'select', model: 'TaskArchive' }, { ids: ['a1'] }))],
      },
      {
        name: "a junction (many-to-many) builder gets the target's residual",
        world: ormWorld({ 'post:read': permit(), 'tag:read': permit(cmp('visibility', 'eq', 'public')) }, [TAG, POST]),
        steps: [as('alice', orm({ op: 'related', model: 'Post', id: 'p1', relation: 'tags' }, { ids: ['g1'] }))],
      },
      { name: "a cloned builder gets the target's residual", world: ormWorld({ 'task:read': OWNER }), steps: [as('alice', orm({ op: 'select', model: 'Task', clone: true }, { ids: ['t1', 't3'] }))] },
    ],
  },
]);
