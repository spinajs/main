import { expect } from 'chai';
import { derive } from './harness.js';
import type { JsonSchema } from '../../src/schema/derive.js';

type Row = { name: string; schema: JsonSchema; id?: string; codes?: string[]; pending?: boolean };

export const ROWS: Row[] = [
  { name: 'PString', schema: { type: 'string' } },
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
