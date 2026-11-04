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
  /** The keywords are DataValidator's (`$data`, ajv-keywords, ajv-merge-patch): the rows are checked against it. */
  plugins?: boolean;
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
    plugins: true,
  },
  DataLimit: {
    title: '$data in a limit reads the sibling, and an absent one checks nothing',
    schema: object({ min: { type: 'number' }, max: { type: 'number', minimum: { $data: '1/min' } } }),
    accepts: [{ min: 1, max: 2 }, { max: 5 }],
    rejects: [{ min: 3, max: 2 }],
    plugins: true,
  },
  DataElsewhere: {
    title: '$data out of the parent object is dropped with ZOD003',
    schema: object({ a: { type: 'number', maximum: { $data: '/b' } }, b: { type: 'number' } }),
    accepts: [{ a: 1, b: 5 }],
    diagnostics: ['ZOD003 /properties/a/maximum'],
    plugins: true,
  },
  Merged: {
    title: '$merge is resolved when the schema is generated',
    schema: { $merge: { source: { $ref: 'test/Str2' }, with: { properties: { b: { type: 'number' } }, required: ['b'] } } },
    accepts: [{ a: 'x', b: 1 }, { b: 1 }],
    rejects: [{ a: 'x' }, { b: 1, c: 1 }, { b: 'x' }],
    plugins: true,
  },
  Patched: {
    title: '$patch is resolved when the schema is generated',
    schema: { $patch: { source: { $ref: 'test/Str2' }, with: [{ op: 'add', path: '/properties/b', value: { type: 'number' } }, { op: 'add', path: '/required/-', value: 'b' }] } },
    accepts: [{ a: 'x', b: 1 }],
    rejects: [{ a: 'x' }, { b: 1 }],
    plugins: true,
  },
  MergeInline: {
    title: "a merge patch is not a schema: its null deletes, and the meta-schema rules do not read it",
    schema: { $merge: { source: object({ a: { type: 'string' }, b: { type: 'number' } }), with: { properties: { b: null, c: { type: 'boolean' } } } } },
    accepts: [{ a: 'x', c: true }],
    rejects: [null, { b: 1 }, { c: 1 }],
    plugins: true,
  },
  MergeMissing: { title: 'a $merge it cannot resolve is dropped with ZOD003', schema: { $merge: { source: { $ref: 'test/Nowhere' }, with: {} } }, accepts: [1], diagnostics: ['ZOD003 /$merge'] },
  Range: { title: 'range and exclusiveRange are the limits', schema: { type: 'number', range: [1, 3], exclusiveRange: [0, 3] }, emits: ['.gte(1).lte(3).gt(0).lt(3)'], accepts: [1, 2.5], rejects: [3, 0.5], plugins: true },
  Transform: {
    title: 'transform runs before the other keywords, and the parsed value is the transformed one',
    schema: object({ s: { type: 'string', transform: ['trim', 'toLowerCase'], enum: ['ab'] }, t: { type: 'string', transform: ['trim'], minLength: 2 } }),
    emits: ["(s) => (typeof s === 'string' ? s.trim().toLowerCase() : s)"],
    accepts: [{ s: ' AB ' }, { t: ' ab ' }],
    rejects: [{ t: ' a ' }, { s: 'x' }],
    plugins: true,
  },
  EnumCase: { title: 'toEnumCase maps to the enum value of the same lower case', schema: object({ s: { type: 'string', transform: ['toEnumCase'], enum: ['ABC', 'Def'] } }), accepts: [{ s: 'abc' }, { s: 'DEF' }], rejects: [{ s: 'x' }], plugins: true },
  Regexp: { title: 'regexp without flags is a regex', schema: { type: 'string', regexp: '/^a+$/' }, emits: [".regex(new RegExp('^a+$', ''))"], accepts: ['aa'], rejects: ['b'], plugins: true },
  RegexpFlags: { title: 'regexp with flags is dropped with ZOD003', schema: { type: 'string', regexp: { pattern: '^a$', flags: 'i' } }, accepts: ['A'], diagnostics: ['ZOD003 /regexp'], plugins: true },
  UniqueBy: {
    title: 'uniqueItemProperties compares the named properties',
    schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } } }, uniqueItemProperties: ['id'] },
    emits: ['uniqueItemProperties(["id"], [true])'],
    accepts: [[{ id: 1 }, { id: 2 }]],
    rejects: [[{ id: 1 }, { id: 1 }]],
    plugins: true,
  },
  Dropped: { title: 'the other ajv-keywords are dropped with ZOD003', schema: { type: 'object', anyRequired: ['a', 'b'], prohibited: ['c'] }, accepts: [{ a: 1 }], diagnostics: ['ZOD003 /anyRequired', 'ZOD003 /prohibited'], plugins: true },
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
          const server = validatorFor(manifest, row.plugins === true);
          for (const [values, verdict] of [[row.accepts, true], [row.rejects, false]] as const) {
            for (const value of values ?? []) {
              expect(schema.safeParse(value).success, `zod on ${JSON.stringify(value)}`).to.equal(verdict);
              expect(serverAccepts(server, `test/${name}`, { coerce: false }, value), `server on ${JSON.stringify(value)}`).to.equal(verdict);
            }
          }
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
