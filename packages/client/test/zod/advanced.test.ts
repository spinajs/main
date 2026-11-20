import 'mocha';
import { expect } from 'chai';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, emitZod, generateClient, type ZodEmitResult } from '../../src/index.js';
import { appBasicManifest } from '../support/fixture.js';
import { serverAccepts, validatorFor } from '../support/server.js';
import { typecheckFiles } from '../support/typecheck.js';
import { clearLoaded, loadZod, manifestWith, schemaIn } from '../support/zod.js';

interface Row {
  title: string;
  schema: unknown;
  emits?: string[];
  mini?: string[];
  accepts?: unknown[];
  rejects?: unknown[];
  diagnostics?: string[];
  /** The server refuses to compile the schema, so only the zod side is compared. */
  serverRefuses?: true;
}

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', properties, additionalProperties: false, ...extra });

// One row per keyword FG-5 maps (plan section 3.2); every verdict is also asked of the server.
const ROWS: Record<string, Row> = {
  Not: { title: 'not refuses what its schema accepts', schema: { type: 'string', not: { const: 'x' } }, emits: [".pipe(z.string())", "'must NOT be valid'"], accepts: ['y'], rejects: ['x', 1] },
  NotNull: { title: 'not also checks null on a nullable node', schema: { type: ['string', 'null'], not: { type: 'null' } }, accepts: ['a'], rejects: [null] },
  IfThenElse: {
    title: 'if/then/else checks then when if matches, else otherwise',
    schema: object({ kind: { type: 'string' }, n: { type: 'number' } }, { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { required: ['n'] }, else: { not: { required: ['n'] } } }),
    emits: ["'must match \"then\" schema'", "'must match \"else\" schema'"],
    accepts: [{ kind: 'a', n: 1 }, { kind: 'b' }],
    rejects: [{ kind: 'a' }, { kind: 'b', n: 1 }],
  },
  IfAlone: { title: 'if without then or else checks nothing', schema: { type: 'number', if: { minimum: 5 } }, emits: ['z.number()'], accepts: [1, 10] },
  MinItemsUntyped: { title: 'minItems holds for items that accept undefined, which a tuple would pad', schema: { type: 'array', minItems: 2 }, accepts: [[1, 2], [1, 2, 3], [null, null]], rejects: [[], [1], [null]] },
  Contains: { title: 'contains needs one matching item', schema: { type: 'array', items: { type: 'number' }, contains: { minimum: 5 } }, emits: ['contains((v) => _check'], accepts: [[1, 5]], rejects: [[1], []] },
  PatternOpen: {
    title: 'patternProperties next to an additionalProperties schema',
    schema: { type: 'object', patternProperties: { '^n': { type: 'number' } }, additionalProperties: { type: 'string' } },
    emits: ['patternProperties([[new RegExp(', 'additionalProperties([], ['],
    accepts: [{ n1: 1, s: 'a' }, {}],
    rejects: [{ n1: 'a' }, { s: 1 }],
  },
  Names: { title: 'propertyNames checks every key, an own __proto__ included', schema: { type: 'object', propertyNames: { pattern: '^[a-z]+$' } }, accepts: [{ ab: 1 }], rejects: [{ A: 1 }, JSON.parse('{"__proto__":1}')] },
  Dependencies: {
    title: 'dependencies: a name list or a schema, for each present key',
    schema: { type: 'object', properties: { a: {}, b: {}, c: { type: 'number' } }, dependencies: { a: ['b'], c: { required: ['a'] } } },
    emits: ['dependencies({ a: ["b"], c: (v) => _check'],
    accepts: [{ a: 1, b: 1 }, {}, { c: 1, a: 1, b: 2 }],
    rejects: [{ a: 1 }, { c: 1 }],
  },
  Counts: {
    title: 'minProperties and maxProperties count the keys as sent',
    schema: { type: 'object', minProperties: 1, maxProperties: 2 },
    emits: ['minProperties(1)', 'maxProperties(2)'],
    accepts: [{ a: 1 }, JSON.parse('{"__proto__":1}')],
    rejects: [{}, { a: 1, b: 2, c: 3 }],
  },
  MergedMembers: {
    title: "a merged allOf applies each member's own keywords",
    schema: { allOf: [{ $ref: 'test/Bounded' }, object({ b: { type: 'number' } })] },
    accepts: [{ a: 'x' }, { a: 'x', b: 1 }],
    rejects: [{}, { a: 'x', b: 1, c: 2 }],
  },
  Confirm: {
    title: '$data in const is checked on the parent object and reported at the property',
    schema: object({ password: { type: 'string' }, confirm: { type: 'string', const: { $data: '1/password' } } }, { required: ['password', 'confirm'] }),
    emits: ["dataLimit('const', Reflect.get(o, 'confirm'), dataRef(o, [\"password\"]))", "path: ['confirm']"],
    accepts: [{ password: 'a', confirm: 'a' }],
    rejects: [{ password: 'a', confirm: 'b' }],
  },
  DataLimit: {
    title: '$data in a limit reads the sibling, and an absent one checks nothing',
    schema: object({ min: { type: 'number' }, max: { type: 'number', minimum: { $data: '1/min' } } }),
    accepts: [{ min: 1, max: 2 }, { max: 5 }],
    rejects: [{ min: 3, max: 2 }],
  },
  DataElsewhere: {
    title: '$data out of the parent object is dropped with ZOD003',
    schema: object({ a: { type: 'number', maximum: { $data: '/b' } }, b: { type: 'number' } }),
    accepts: [{ a: 1, b: 5 }],
    diagnostics: ['ZOD003 /properties/a/maximum'],
  },
  Merged: {
    title: '$merge is resolved when the schema is generated',
    schema: { $merge: { source: { $ref: 'test/Str2' }, with: { properties: { b: { type: 'number' } }, required: ['b'] } } },
    accepts: [{ a: 'x', b: 1 }, { b: 1 }],
    rejects: [{ a: 'x' }, { b: 1, c: 1 }, { b: 'x' }],
  },
  Patched: {
    title: '$patch is resolved when the schema is generated',
    schema: { $patch: { source: { $ref: 'test/Str2' }, with: [{ op: 'add', path: '/properties/b', value: { type: 'number' } }, { op: 'add', path: '/required/-', value: 'b' }] } },
    accepts: [{ a: 'x', b: 1 }],
    rejects: [{ a: 'x' }, { b: 1 }],
  },
  MergeInline: {
    title: "a merge patch is not a schema: its null deletes, and the meta-schema rules do not read it",
    schema: { $merge: { source: object({ a: { type: 'string' }, b: { type: 'number' } }), with: { properties: { b: null, c: { type: 'boolean' } } } } },
    accepts: [{ a: 'x', c: true }],
    rejects: [null, { b: 1 }, { c: 1 }],
  },
  MergeMissing: { title: 'a $merge it cannot resolve is dropped with ZOD003', schema: { $merge: { source: { $ref: 'test/Nowhere' }, with: {} } }, accepts: [1], diagnostics: ['ZOD003 /$merge'], serverRefuses: true },
  Range: { title: 'range and exclusiveRange are the limits', schema: { type: 'number', range: [1, 3], exclusiveRange: [0, 3] }, emits: ['.gte(1).lte(3).gt(0).lt(3)'], accepts: [1, 2.5], rejects: [3, 0.5] },
  Transform: {
    title: 'transform runs before the other keywords, and the parsed value is the transformed one',
    schema: object({ s: { type: 'string', transform: ['trim', 'toLowerCase'], enum: ['ab'] }, t: { type: 'string', transform: ['trim'], minLength: 2 } }),
    emits: ["(s) => (typeof s === 'string' ? s.trim().toLowerCase() : s)"],
    accepts: [{ s: ' AB ' }, { t: ' ab ' }],
    rejects: [{ t: ' a ' }, { s: 'x' }],
  },
  EnumCase: { title: 'toEnumCase maps to the enum value of the same lower case', schema: object({ s: { type: 'string', transform: ['toEnumCase'], enum: ['ABC', 'Def'] } }), accepts: [{ s: 'abc' }, { s: 'DEF' }], rejects: [{ s: 'x' }] },
  Regexp: { title: 'regexp without flags is a regex', schema: { type: 'string', regexp: '/^a+$/' }, emits: [".regex(new RegExp('^a+$', ''))"], accepts: ['aa'], rejects: ['b'] },
  RegexpFlags: { title: 'regexp with flags is dropped with ZOD003', schema: { type: 'string', regexp: { pattern: '^a$', flags: 'i' } }, accepts: ['A'], diagnostics: ['ZOD003 /regexp'] },
  UniqueBy: {
    title: 'uniqueItemProperties compares the named properties',
    schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } } }, uniqueItemProperties: ['id'] },
    emits: ['uniqueItemProperties(["id"], [true])'],
    accepts: [[{ id: 1 }, { id: 2 }]],
    rejects: [[{ id: 1 }, { id: 1 }]],
  },
  Dropped: { title: 'the other ajv-keywords are dropped with ZOD003', schema: { type: 'object', anyRequired: ['a', 'b'], prohibited: ['c'] }, accepts: [{ a: 1 }], diagnostics: ['ZOD003 /anyRequired', 'ZOD003 /prohibited'] },
  UniqueAsSent: {
    title: "uniqueItems compares the items as sent: zod's parsed items lose an own __proto__ key",
    schema: { type: 'array', items: { type: 'object' }, uniqueItems: true },
    accepts: [[JSON.parse('{"__proto__":1}'), {}], [{ a: 1 }, { a: 2 }]],
    rejects: [[{ a: 1 }, { a: 1 }]],
  },
  UniqueStrings: {
    title: 'uniqueItems on items that cannot be a loose object checks the parsed array, so the input stays typed',
    schema: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    emits: ["z.array(z.string()).refine(ajvUniqueItems, 'must NOT have duplicate items')"],
    mini: ["z.array(z.string()).check(z.refine(ajvUniqueItems, 'must NOT have duplicate items'))"],
    accepts: [['a', 'b']],
    rejects: [['a', 'a']],
  },
  EnumType: { title: 'enum keeps its type sibling', schema: { type: 'integer', enum: [1, 2.5] }, accepts: [1], rejects: [2.5, 3] },
  EnumLength: { title: 'enum keeps its minLength sibling', schema: { enum: ['a', 'bb', 1], minLength: 2 }, accepts: ['bb', 1], rejects: ['a', 'ccc'] },
  EnumItems: { title: 'enum keeps its maxItems sibling', schema: { enum: [[1], [1, 2], 'x'], maxItems: 1 }, accepts: [[1], 'x'], rejects: [[1, 2]] },
  ConstType: { title: 'const keeps its type sibling', schema: { const: 5, type: 'string' }, rejects: [5, '5'] },
  ConstLimit: { title: 'const keeps its minimum sibling', schema: { const: 3, minimum: 4 }, rejects: [3, 4] },
  ConstObject: { title: 'const keeps the required of an object sibling', schema: { const: { a: 1 }, required: ['b'] }, rejects: [{ a: 1 }, { a: 1, b: 2 }] },
  ConstFormat: { title: 'const keeps its format sibling', schema: { const: 'x', format: 'email' }, rejects: ['x'] },
  ConstPlain: { title: 'const alone is a literal', schema: { const: 'x', description: 'd' }, accepts: ['x'], rejects: ['y', 1] },
  ContainsTypeless: { title: 'contains on a node without a type checks arrays only', schema: { contains: { const: 1 } }, accepts: [[1], [2, 1], 'x', 3, {}], rejects: [[2], []] },
  ContainsTypelessItems: { title: 'contains next to items on a node without a type', schema: { items: { type: 'number' }, contains: { minimum: 5 } }, accepts: [[1, 5], 'x'], rejects: [[1], ['a', 6]] },
  RefClosedSibling: {
    title: 'a $ref to a closed object keeps it closed next to sibling keywords',
    schema: { $ref: 'test/Str2', required: ['a'], description: 'x' },
    accepts: [{ a: 'x' }],
    rejects: [{ a: 'x', zz: 1 }, { a: 'x', toString: 1 }, JSON.parse('{"a":"x","__proto__":1}'), {}],
  },
  BigInIntersection: {
    title: 'an intersection scans a value of any size for a non-finite number without growing the stack',
    schema: { type: 'object', properties: { v: {}, a: { type: 'array', items: { type: 'number' } } }, allOf: [{ properties: { w: {} } }] },
    accepts: [{ a: new Array<number>(250000).fill(1) }],
    rejects: [{ a: [...new Array<number>(250000).fill(1), Number.NaN] }],
  },
  RefClosedInGetter: {
    title: 'a $ref to a closed object keeps it closed next to sibling keywords inside a cyclic declaration',
    schema: object({ x: { type: 'string' }, kid: { $ref: 'test/RefClosedInGetter', required: ['x'] } }),
    accepts: [{ x: 'a' }, { x: 'a', kid: { x: 'b' } }],
    rejects: [{ x: 'a', kid: { x: 'b', zz: 1 } }, { x: 'a', kid: { x: 'b', toString: 1 } }, { x: 'a', kid: {} }],
  },
  ProtoCatchall: {
    title: 'an own __proto__ key is checked by the additionalProperties schema, which zod drops from the parsed object',
    schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } },
    accepts: [{ a: 'x', z: 1 }, JSON.parse('{"a":"x","__proto__":1}')],
    rejects: [JSON.parse('{"__proto__":"p"}'), JSON.parse('{"a":"x","__proto__":null}'), { z: 'p' }],
  },
  MinItemsHoisted: {
    title: 'minItems holds for a slot printed once, whose schema accepts undefined',
    schema: { type: 'array', items: { not: { type: 'number' } }, minItems: 2 },
    accepts: [['x', 'y'], ['x', 'y', 'z']],
    rejects: [['x'], [], ['x', 1]],
  },
  NanInIntersection: {
    title: 'a NaN in an untyped property of an intersection is refused, where zod could not merge it and threw',
    schema: { type: 'object', properties: { v: {} }, allOf: [{ properties: { w: {} } }] },
    accepts: [{ v: 1, w: 'a' }],
    rejects: [{ v: Number.NaN }, { w: Number.NaN }, { v: Number.NaN, w: Number.NaN }],
  },
  AppKeyword: {
    title: 'a keyword the server does not know, such as one an app adds to its Ajv, is dropped with ZOD003',
    schema: { type: 'string', isUnique: 'users.email', $async: true, title: 'x', deprecated: true, $comment: 'c' },
    accepts: ['a'],
    diagnostics: ['ZOD003 /$async', 'ZOD003 /isUnique'],
  },
};

const EXTRA: Record<string, unknown> = {
  'test/Str2': object({ a: { type: 'string' } }, { required: ['a'] }),
  'test/Bounded': object({ a: { type: 'string' } }, { minProperties: 1 }),
};

function declarationOf(contents: string, name: string): string {
  const start = contents.indexOf(`export const ${name}Schema`);
  if (start < 0) throw new Error(`no declaration of ${name}Schema`);
  return contents.slice(start, contents.indexOf(';\n', start) + 1);
}

describe('emitZod: advanced keywords', function () {
  this.timeout(60000);

  let manifest: Manifest;
  let client: string;

  before(async () => {
    manifest = manifestWith(await appBasicManifest(), Object.fromEntries(Object.entries(ROWS).map(([name, row]) => [name, row.schema])), EXTRA);
    client = await generateClient({ manifest });
  });

  after(clearLoaded);

  for (const mini of [false, true]) {
    describe(mini ? 'zod/mini' : 'zod', () => {
      let result: ZodEmitResult;
      let module: Record<string, unknown>;

      before(async () => {
        result = emitZod(buildClientModel(manifest), { mini });
        module = await loadZod(result.contents);
      });

      it('type-checks against the interfaces of client.ts', () => {
        expect(typecheckFiles({ 'client.ts': `${client}export const manifestHash = '${manifest.hash}';\n`, 'client.zod.ts': result.contents }, { noUnusedLocals: true })).to.deep.equal([]);
      });

      for (const [name, row] of Object.entries(ROWS)) {
        it(row.title, () => {
          const declaration = declarationOf(result.contents, name);
          for (const text of (mini ? row.mini : row.emits) ?? []) expect(declaration).to.include(text);
          const schema = schemaIn(module, `${name}Schema`);
          const server = validatorFor(manifest);
          for (const [values, verdict] of [[row.accepts, true], [row.rejects, false]] as const) {
            for (const value of values ?? []) {
              expect(schema.safeParse(value).success, `zod on ${JSON.stringify(value)}`).to.equal(verdict);
              if (!row.serverRefuses) expect(serverAccepts(server, `test/${name}`, { coerce: false }, value), `server on ${JSON.stringify(value)}`).to.equal(verdict);
            }
          }
          if (row.serverRefuses) expect(() => server.validator(`test/${name}`, { coerce: false })).to.throw(`schema test/${name} is not a valid JSON Schema`);
          const codes = result.diagnostics.filter((d) => d.schema === `test/${name}`).map((d) => `${d.code} ${d.pointer}`);
          expect(codes).to.deep.equal(row.diagnostics ?? []);
        });
      }

      it('returns the transformed value', () => {
        expect(schemaIn(module, 'TransformSchema').safeParse({ s: ' AB ' }).data).to.deep.equal({ s: 'ab' });
      });
    });
  }
});
