import 'mocha';
import { expect } from 'chai';
import { buildClientModel, emitZod } from '../../src/index.js';
import { appBasicManifest } from '../support/fixture.js';
import { parityManifest } from '../support/parity.js';
import { manifestWith } from '../support/zod.js';

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', properties, additionalProperties: false, ...extra });

interface Row {
  title: string;
  schema: unknown;
  /** `ZOD004` pointers; none when the coercion order cannot change a verdict. */
  pointers: string[];
}

const ROWS: Record<string, Row> = {
  IfCoerces: { title: 'an if that coerces: then and else read the value it left, so nothing is reported', schema: object({ v: { if: { type: 'number' }, then: { minimum: 3 } } }), pointers: [] },
  IfCoercesElse: { title: 'an else reads what the if coerced', schema: { if: { type: 'string' }, else: { minimum: 3 } }, pointers: [] },
  IfThenAnyOf: { title: 'an if after an anyOf that coerces still reads the value as sent', schema: { anyOf: [{ type: 'integer' }, { type: 'object' }], if: { minimum: 1 }, then: { minimum: 2 } }, pointers: ['/anyOf/0'] },
  IfNoBranch: { title: 'an if nothing reads after', schema: object({ v: { if: { type: 'number' } } }), pointers: [] },
  IfNoType: { title: 'an if that does not coerce', schema: object({ v: { if: { minimum: 5 }, then: { multipleOf: 2 } } }), pointers: [] },
  IfCovered: { title: 'an if of the type the node already coerced to', schema: object({ v: { type: 'number', if: { type: 'number' }, then: { minimum: 3 } } }), pointers: [] },
  IfObject: { title: 'an if of a type Ajv never coerces to', schema: object({ v: { if: { type: 'object' }, then: { minProperties: 1 } } }), pointers: [] },
  AnyOfCoerces: { title: 'an anyOf member that coerces, next to a keyword that reads the result', schema: object({ v: { minimum: 1, anyOf: [{ type: 'integer' }, { type: 'object' }] } }), pointers: ['/properties/v/anyOf/0'] },
  OneOfCoerces: { title: 'every oneOf member that coerces', schema: object({ v: { maxLength: 3, oneOf: [{ type: 'boolean' }, { type: 'null' }] } }), pointers: ['/properties/v/oneOf/0', '/properties/v/oneOf/1'] },
  NotCoerces: { title: 'a not that coerces', schema: object({ v: { minLength: 1, not: { type: 'number' } } }), pointers: ['/properties/v/not'] },
  AnyOfAlone: { title: 'an anyOf with no sibling keyword to read the result', schema: object({ v: { anyOf: [{ type: 'integer' }, { type: 'string' }] } }), pointers: [] },
  AnyOfCovered: { title: 'an anyOf of the types the node coerced to first', schema: object({ v: { type: 'number', minimum: 1, anyOf: [{ type: 'integer' }, { type: 'number' }] } }), pointers: [] },
  IfSibling: { title: 'an if with no then or else is not run', schema: object({ v: { minimum: 1, if: { type: 'string' } } }), pointers: [] },
  DataAfter: {
    title: 'a $data keyword reads a sibling as Ajv does, so nothing is reported',
    schema: object({ max: { type: 'number', minimum: { $data: '1/min' } }, min: { type: 'number' } }),
    pointers: [],
  },
  DataDeep: {
    title: 'a $data keyword reads a property below a sibling as Ajv does',
    schema: object({ name: { type: 'string', maxLength: { $data: '1/limits/name' } }, limits: { type: 'object', properties: { name: { type: 'integer' } } } }),
    pointers: [],
  },
  DataBefore: { title: 'a $data keyword that reads a sibling coerced before it', schema: object({ min: { type: 'number' }, max: { type: 'number', minimum: { $data: '1/min' } } }), pointers: [] },
  DataPlain: { title: 'a $data keyword that reads a sibling nothing coerces', schema: object({ max: { type: 'number', minimum: { $data: '1/min' } }, min: { type: 'object' } }), pointers: [] },
  PatternReads: { title: 'a pattern reads a property as Ajv coerced it, so nothing is reported', schema: { type: 'object', properties: { a: { type: 'number' } }, patternProperties: { '^a$': { minimum: 3 } } }, pointers: [] },
  PatternReadsMany: { title: 'the same for each pattern that matches a coerced property', schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'object' } }, patternProperties: { '^a': { minimum: 3 }, '^z': { type: 'string' }, '^b': { type: 'object' } } }, pointers: [] },
  PatternReadsDeep: { title: 'a pattern reads a property whose allOf coerces below its top', schema: { type: 'object', properties: { b: { allOf: [{ type: 'number' }] } }, patternProperties: { '^b': { type: 'number', minimum: 3 } } }, pointers: [] },
  PatternMisses: { title: 'a pattern that matches no coerced property', schema: { type: 'object', properties: { a: { type: 'number' } }, patternProperties: { '^x': { minimum: 3 } } }, pointers: [] },
  PatternPlain: { title: 'a pattern that matches a property Ajv does not coerce', schema: { type: 'object', properties: { a: {}, b: { type: 'object' } }, patternProperties: { '^[ab]$': { type: 'object' } } }, pointers: [] },
  PatternOnly: { title: 'patternProperties without a declared property', schema: { type: 'object', patternProperties: { '^x': { type: 'number' } } }, pointers: [] },
};

describe('emitZod: ZOD004, a coercion a later keyword reads', function () {
  this.timeout(60000);

  const found = async (manifest = parityManifest) => {
    const base = await appBasicManifest();
    const named = Object.fromEntries(Object.entries(ROWS).map(([name, row]) => [name, row.schema]));
    return emitZod(buildClientModel(manifest(base, named)), { replies: true }).diagnostics.filter((d) => d.code === 'ZOD004');
  };

  it('names the node whose later keyword reads a value Ajv coerced, and none other', async () => {
    const diagnostics = await found();
    for (const [name, row] of Object.entries(ROWS)) {
      expect(diagnostics.filter((d) => d.schema === `test/${name}`).map((d) => d.pointer), row.title).to.deep.equal(row.pointers);
    }
  });

  it('says nothing for a schema no argument coerces', async () => {
    expect(await found(manifestWith)).to.deep.equal([]);
  });
});
