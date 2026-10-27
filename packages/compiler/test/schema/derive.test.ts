import { expect } from 'chai';
import { derive, ref } from './harness.js';
import type { JsonSchema } from '../../src/schema/derive.js';

type Row = { name: string; schema: JsonSchema; id?: string; codes?: string[] };

export const ROWS: Row[] = [
  { name: 'PString', schema: { type: 'string' } },
  { name: 'PNumber', schema: { type: 'number' } },
  { name: 'PBoolean', schema: { type: 'boolean' } },
  { name: 'PBigint', schema: { type: 'string', pattern: '^-?[0-9]+$' } },
  { name: 'PNull', schema: { type: 'null' } },
  { name: 'LStr', schema: { const: 'a' } },
  { name: 'LNum', schema: { const: 1 } },
  { name: 'LBool', schema: { const: true } },
  { name: 'LUnion', schema: { enum: ['a', 'b'] } },
  { name: 'LNumUnion', schema: { enum: [1, 2] } },
  { name: 'Color', schema: { $id: 'fixture/Color', enum: ['red', 'blue'] }, id: 'fixture/Color' },
  { name: 'Level', schema: { $id: 'fixture/Level', enum: [0, 1] }, id: 'fixture/Level' },
  { name: 'AStr', schema: { type: 'array', items: { type: 'string' } } },
  { name: 'AGeneric', schema: { type: 'array', items: { type: 'number' } } },
  { name: 'AReadonly', schema: { type: 'array', items: { type: 'string' } } },
  { name: 'ANested', schema: { type: 'array', items: { type: 'array', items: { type: 'string' } } } },
  { name: 'TPair', schema: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], minItems: 2, maxItems: 2, additionalItems: false } },
  { name: 'TOptional', schema: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], minItems: 1, maxItems: 2, additionalItems: false } },
  { name: 'TRest', schema: { type: 'array', items: [{ type: 'string' }], minItems: 1, additionalItems: { type: 'number' } } },
  { name: 'UNullable', schema: { type: ['string', 'null'] } },
  { name: 'UOptionalUndef', schema: { type: 'string' } },
  { name: 'UMixed', schema: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
  { name: 'UBoolOrStr', schema: { anyOf: [{ type: 'boolean' }, { const: 'auto' }] } },
  { name: 'UObjNull', schema: { anyOf: [ref('Point'), { type: 'null' }] } },
  { name: 'Shape', schema: { oneOf: [ref('Circle'), ref('Square')], 'x-discriminator': { propertyName: 'kind', mapping: { circle: 'fixture/Circle', square: 'fixture/Square' } } } },
  { name: 'IAB', schema: { allOf: [ref('A'), ref('B')] } },
  { name: 'Point', id: 'fixture/Point', schema: { $id: 'fixture/Point', type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } },
  { name: 'OOptional', id: 'fixture/OOptional', schema: { $id: 'fixture/OOptional', type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'], additionalProperties: false } },
  { name: 'OReadonly', id: 'fixture/OReadonly', schema: { $id: 'fixture/OReadonly', type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false } },
  { name: 'OMethods', id: 'fixture/OMethods', schema: { $id: 'fixture/OMethods', type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false } },
  { name: 'OIndex', id: 'fixture/OIndex', schema: { $id: 'fixture/OIndex', type: 'object', additionalProperties: { type: 'number' } } },
  { name: 'ORecord', schema: { type: 'object', additionalProperties: { type: 'boolean' } } },
  { name: 'OLiteral', id: 'fixture/OLiteral', schema: { $id: 'fixture/OLiteral', type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false } },
  { name: 'CDto', id: 'fixture/CDto', schema: { $id: 'fixture/CDto', type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'], additionalProperties: false } },
  { name: 'UPartial', schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false } },
  { name: 'UPick', schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } },
  { name: 'UOmit', schema: { type: 'object', properties: { y: { type: 'number' } }, required: ['y'], additionalProperties: false } },
  { name: 'URequired', schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } },
  { name: 'Tree', id: 'fixture/Tree', schema: { $id: 'fixture/Tree', type: 'object', properties: { value: { type: 'number' }, children: { type: 'array', items: ref('Tree') } }, required: ['value', 'children'], additionalProperties: false } },
  { name: 'JDoc', id: 'fixture/JDoc', schema: { $id: 'fixture/JDoc', type: 'object', additionalProperties: false, required: ['name', 'score', 'email', 'when', 'tags'], properties: {
      name: { type: 'string', description: 'The display name', minLength: 1, maxLength: 10 },
      score: { type: 'number', minimum: 0, maximum: 100, default: 50 },
      email: { type: 'string', pattern: '^[a-z]+$', format: 'email' },
      when: { type: 'string', examples: ['2020-01-01'] },
      old: { type: 'string', deprecated: true },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
  } } },
  { name: 'A', id: 'fixture/A', schema: { $id: 'fixture/A', type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false } },
  { name: 'B', id: 'fixture/B', schema: { $id: 'fixture/B', type: 'object', properties: { b: { type: 'number' } }, required: ['b'], additionalProperties: false } },
  { name: 'Circle', id: 'fixture/Circle', schema: { $id: 'fixture/Circle', type: 'object', properties: { kind: { const: 'circle' }, r: { type: 'number' } }, required: ['kind', 'r'], additionalProperties: false } },
  { name: 'Square', id: 'fixture/Square', schema: { $id: 'fixture/Square', type: 'object', properties: { kind: { const: 'square' }, side: { type: 'number' } }, required: ['kind', 'side'], additionalProperties: false } },
  { name: 'GPage', id: 'fixture/Page_Point', schema: { $id: 'fixture/Page_Point', type: 'object', properties: { items: { type: 'array', items: ref('Point') }, total: { type: 'number' } }, required: ['items', 'total'], additionalProperties: false } },
  { name: 'GNested', id: 'fixture/Page_Page_Point', schema: { $id: 'fixture/Page_Page_Point', type: 'object', properties: { items: { type: 'array', items: ref('Page_Point') }, total: { type: 'number' } }, required: ['items', 'total'], additionalProperties: false } },
  { name: 'WDate', schema: { type: 'string', format: 'date-time' } },
  { name: 'WDateTime', schema: { type: 'string', format: 'date-time' } },
  { name: 'WBuffer', schema: { type: 'string', format: 'binary' } },
  { name: 'WU8', schema: { type: 'string', format: 'binary' } },
  { name: 'WF32', schema: { type: 'string', format: 'binary' } },
  { name: 'WReadable', schema: { type: 'string', format: 'binary' } },
  { name: 'WStream', schema: { type: 'string', format: 'binary' } },
  { name: 'XAny', schema: {}, codes: ['SCH001'] },
  { name: 'XUnknown', schema: {}, codes: ['SCH001'] },
  { name: 'XObject', schema: { type: 'object' }, codes: ['SCH001'] },
  { name: 'XFn', schema: {}, codes: ['SCH001'] },
  { name: 'XSymbol', schema: {}, codes: ['SCH001'] },
  { name: 'XNever', schema: {}, codes: ['SCH001'] },
  { name: 'XVoid', schema: {} },
];

describe('deriveSchema', () => {
  for (const row of ROWS) {
    it(`derives ${row.name}`, () => {
      const result = derive(row.name);
      expect(result.schema).to.deep.equal(row.schema);
      expect(result.id).to.equal(row.id);
      if (row.id) expect(result.registry.get(row.id)).to.deep.equal(result.schema);
      expect(result.diagnostics.map((d) => d.code)).to.deep.equal(row.codes ?? []);
    });
  }
});

describe('deriveSchema depth limit', () => {
  it('replaces nesting beyond maxDepth with {} and reports SCH002 once per cut', () => {
    const result = derive('Deep', { maxDepth: 3 });
    expect(result.schema).to.deep.equal({
      $id: 'fixture/Deep', type: 'object', additionalProperties: false, required: ['a'],
      properties: { a: { type: 'object', additionalProperties: false, required: ['b'], properties: { b: { type: 'object', additionalProperties: false, required: ['c'], properties: { c: {} } } } } },
    });
    expect(result.diagnostics).to.have.length(1);
    expect(result.diagnostics[0]).to.include({ code: 'SCH002', severity: 'warning' });
  });
  it('closes recursion through the registry without revisiting the body', () => {
    const result = derive('Tree');
    expect([...result.registry.keys()]).to.deep.equal(['fixture/Tree']);
    expect(result.diagnostics).to.deep.equal([]);
  });
});

describe('SCH001 severity', () => {
  it('is info for unknown and object, warning otherwise', () => {
    expect(derive('XUnknown').diagnostics[0].severity).to.equal('info');
    expect(derive('XObject').diagnostics[0].severity).to.equal('info');
    expect(derive('XAny').diagnostics[0].severity).to.equal('warning');
    expect(derive('XFn').diagnostics[0].severity).to.equal('warning');
  });
});

describe('deriveSchema naming', () => {
  it('registers every hoisted dependency of a nested generic', () => {
    const result = derive('GNested');
    expect([...result.registry.keys()]).to.deep.equal(['fixture/Page_Page_Point', 'fixture/Page_Point', 'fixture/Point']);
  });
});

describe('deriveSchema review fixes', () => {
  it('does not require a property whose type includes undefined', () => {
    expect(derive('OUndef').schema.required).to.deep.equal(['y']);
    expect(derive('CUndef').schema.required).to.deep.equal(['z']);
  });
  it('reports an any-typed index signature', () => {
    const result = derive('OAnyIndex');
    expect(result.schema.additionalProperties).to.deep.equal({});
    expect(result.diagnostics.map((d) => d.code)).to.deep.equal(['SCH001']);
    expect(result.diagnostics[0].message).to.include('index signature');
  });
  it('does not derive the class behind a string @Schema', () => {
    const result = derive('ExplicitRefNested');
    expect(result.schema).to.deep.equal({ $id: 'fixture/ExplicitRefNested', $ref: 'fixture/by-ref-with-body' });
    expect([...result.registry.keys()]).to.deep.equal(['fixture/ExplicitRefNested']);
    expect(result.diagnostics).to.deep.equal([]);
  });
});

describe('deriveSchema id collisions', () => {
  it('warns SCH005 when two different types hoist to the same id', () => {
    const result = derive('Collide');
    const collisions = result.diagnostics.filter((d) => d.code === 'SCH005');
    expect(collisions).to.have.length(1);
    expect(collisions[0].severity).to.equal('warning');
    expect(collisions[0].message).to.include('fixture/Point');
  });
  it('stays silent when the same type is derived again', () => {
    const result = derive('GNested');
    expect(result.diagnostics.filter((d) => d.code === 'SCH005')).to.deep.equal([]);
  });
});

describe('deriveSchema template literal types', () => {
  const rows: Array<[string, JsonSchema]> = [
    ['TPrefix', { type: 'string', pattern: '^native:' }],
    ['TSuffix', { type: 'string', pattern: '\\.json$' }],
    ['TInfix', { type: 'string', pattern: '^a.*b.*c$' }],
    ['TNumber', { type: 'string' }],
    ['TUpper', { type: 'string' }],
  ];
  for (const [name, schema] of rows) {
    it(`derives ${name} as a string`, () => {
      const result = derive(name);
      expect(result.schema).to.deep.equal(schema);
      expect(result.diagnostics).to.deep.equal([]);
    });
  }
});

describe('deriveSchema recursive aliases', () => {
  const node = (props: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
  const R_FILTER: JsonSchema = {
    $id: 'fixture/RFilter',
    oneOf: [
      node({ op: { const: 'not' }, arg: ref('RFilter') }),
      node({ op: { const: 'and' }, args: { type: 'array', items: ref('RFilter') } }),
      node({ op: { const: 'leaf' }, field: { type: 'string' } }),
    ],
  };
  it('hoists a recursive union alias so the recursion closes through $ref', () => {
    const result = derive('RFilter');
    expect(result.id).to.equal('fixture/RFilter');
    expect(result.schema).to.deep.equal(R_FILTER);
    expect(result.diagnostics).to.deep.equal([]);
  });
  it('references the hoisted alias from every use and derives it once', () => {
    const result = derive('RHolder');
    expect(result.schema.properties).to.deep.equal({ filter: ref('RFilter'), again: ref('RFilter') });
    expect(result.registry.get('fixture/RFilter')).to.deep.equal(R_FILTER);
    expect(result.diagnostics).to.deep.equal([]);
  });
  const LEAF: JsonSchema = node({ op: { const: 'leaf' }, field: { type: 'string' } });
  it('closes an optional self-reference through $ref', () => {
    const result = derive('OFilter');
    expect(result.schema).to.deep.equal({
      $id: 'fixture/OFilter',
      oneOf: [{ type: 'object', properties: { op: { const: 'not' }, arg: ref('OFilter') }, required: ['op'], additionalProperties: false }, LEAF],
    });
    expect(result.diagnostics).to.deep.equal([]);
  });
  it('closes a nullable self-reference through $ref', () => {
    const result = derive('NFilter');
    expect(result.schema).to.deep.equal({
      $id: 'fixture/NFilter',
      oneOf: [node({ op: { const: 'not' }, arg: { anyOf: [ref('NFilter'), { type: 'null' }] } }), LEAF],
    });
    expect(result.diagnostics).to.deep.equal([]);
  });
  it('references a hoisted alias from its optional and nullable uses', () => {
    const result = derive('OHolder');
    expect(result.schema.properties).to.deep.equal({ filter: ref('OFilter'), maybe: ref('OFilter'), nullable: { anyOf: [ref('NFilter'), { type: 'null' }] } });
    expect(result.diagnostics).to.deep.equal([]);
  });
  it('keeps a non-recursive union alias inline', () => {
    expect(derive('UMixed').id).to.equal(undefined);
    expect(derive('Shape').id).to.equal(undefined);
  });
});

describe('deriveSchema class members', () => {
  it('keeps public instance data members only', () => {
    const result = derive('CVisibility');
    expect(result.schema).to.deep.equal({ $id: 'fixture/CVisibility', type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false });
    expect(result.diagnostics).to.deep.equal([]);
  });
});
