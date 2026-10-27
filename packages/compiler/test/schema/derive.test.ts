import { expect } from 'chai';
import { derive, ref } from './harness.js';
import type { JsonSchema } from '../../src/schema/derive.js';

type Row = { name: string; schema: JsonSchema; id?: string; codes?: string[]; pending?: boolean };

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
  { name: 'Color', schema: { $id: 'fixture/Color', enum: ['red', 'blue'] }, id: 'fixture/Color', pending: true },
  { name: 'Level', schema: { $id: 'fixture/Level', enum: [0, 1] }, id: 'fixture/Level', pending: true },
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
  { name: 'UObjNull', schema: { anyOf: [ref('Point'), { type: 'null' }] }, pending: true },
  { name: 'Shape', schema: { oneOf: [ref('Circle'), ref('Square')], 'x-discriminator': { propertyName: 'kind', mapping: { circle: 'fixture/Circle', square: 'fixture/Square' } } }, pending: true },
  { name: 'IAB', schema: { allOf: [ref('A'), ref('B')] }, pending: true },
];

describe('deriveSchema', () => {
  for (const row of ROWS) {
    const run = row.pending ? it.skip : it;
    run(`derives ${row.name}`, () => {
      const result = derive(row.name);
      expect(result.schema).to.deep.equal(row.schema);
      expect(result.id).to.equal(row.id);
      if (row.id) expect(result.registry.get(row.id)).to.deep.equal(result.schema);
      expect(result.diagnostics.map((d) => d.code)).to.deep.equal(row.codes ?? []);
    });
  }
});
