import type { Manifest, ParamEntry, RouteEntry } from '@spinajs/manifest';

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };
const id = (name: string) => `spinajs/models/${name}`;
const ref = (name: string) => ({ $ref: id(name) });
const at = { type: 'string', format: 'date-time', 'x-spinajs-type': 'Date' };

const closed = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });

/** Schemas for every conversion the model emitter plans, around app-basic's `UserDto`. */
export const modelSchemas: Record<string, unknown> = {
  [id('EventDto')]: closed(
    {
      id: { type: 'number' },
      at,
      day: { type: 'string', format: 'date' },
      price: { type: 'string', format: 'decimal', 'x-spinajs-type': 'Decimal' },
      big: { type: 'string', pattern: '^-?[0-9]+$', 'x-spinajs-type': 'bigint' },
      endsAt: { type: ['string', 'null'], format: 'date-time', 'x-spinajs-type': 'DateTime' },
      history: { type: 'array', items: at },
      owner: { $ref: 'spinajs/app-basic/UserDto' },
      meta: closed({ seenAt: at, note: { type: 'string' } }, ['seenAt']),
      either: { anyOf: [at, { type: 'number' }] },
      shape: ref('Shape'),
      audit: ref('Audit'),
      marks: { type: 'object', additionalProperties: at },
      status: ref('Status'),
      parent: { anyOf: [ref('EventDto'), { type: 'null' }] },
      tuple: { type: 'array', items: [at, { type: 'number' }] },
    },
    ['id', 'at'],
  ),
  [id('Shape')]: { oneOf: [ref('Circle'), ref('Square')], 'x-discriminator': { propertyName: 'kind', mapping: { circle: id('Circle'), square: id('Square') } } },
  [id('Circle')]: closed({ kind: { const: 'circle' }, r: { type: 'number' }, drawnAt: at }, ['kind', 'r']),
  [id('Square')]: closed({ kind: { const: 'square' }, side: { type: 'number' } }, ['kind', 'side']),
  [id('Stamp')]: closed({ at }, ['at']),
  [id('Audit')]: { allOf: [ref('Stamp'), closed({ by: { type: 'string' } }, ['by'])] },
  [id('Status')]: { enum: ['open', 'closed'] },
  [id('Note')]: { type: 'object', properties: { text: { type: 'string' } } },
  [id('EventsController_list_Response')]: { type: 'array', items: ref('EventDto') },
  [id('EventsController_since_from')]: at,
  [id('EventsController_stamp_Response')]: closed({ when: at, label: { type: 'string' } }, ['when', 'label']),
};

function param(index: number, name: string, kind: string, wire: ParamEntry['wire'], text: string, schema?: string): ParamEntry {
  return { index, name, kind, runtimeType: { text, ...(schema ? { schema } : {}) }, required: true, wire };
}

function route(handler: string, method: RouteEntry['method'], fullPath: string, params: ParamEntry[], returnType: RouteEntry['returnType']): RouteEntry {
  return { method, path: '', handler, fullPath, params, returnType, policies: [], middlewares: [], source };
}

const list = { text: 'EventDto[]', schema: id('EventsController_list_Response') };

const routes: RouteEntry[] = [
  route('get', 'get', '/events/:id', [param(0, 'id', 'FromParams', { in: 'path', name: 'id', shape: 'value' }, 'number')], { text: 'EventDto', schema: id('EventDto') }),
  route('list', 'get', '/events/list', [], list),
  route('since', 'get', '/events/since', [param(0, 'from', 'FromQuery', { in: 'query', name: 'from', shape: 'value' }, 'Date', id('EventsController_since_from'))], list),
  route('save', 'post', '/events/save', [param(0, 'body', 'FromBody', { in: 'body', shape: 'whole' }, 'EventDto', id('EventDto'))], { text: 'void' }),
  route('shape', 'get', '/events/shape', [], { text: 'Shape', schema: id('Shape') }),
  route('stamp', 'get', '/events/stamp', [], { text: '{ when: Date; label: string; }', schema: id('EventsController_stamp_Response') }),
  route('note', 'get', '/events/note', [], { text: 'Note', schema: id('Note') }),
];

/** app-basic plus an `EventsController` whose schemas hold dates, decimals, bigints, unions and intersections. */
export function modelsManifest(base: Manifest): Manifest {
  return {
    ...base,
    schemas: { ...base.schemas, ...modelSchemas },
    controllers: [...base.controllers, { id: 'x:EventsController', className: 'EventsController', basePath: 'events', policies: [], middlewares: [], routes, source }],
  };
}
