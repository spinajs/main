import { expect } from 'chai';
import { derive } from './harness.js';

describe('explicit @Schema', () => {
  it('wins over the derived schema and keeps the derived one as x-derived', () => {
    const result = derive('ExplicitDto');
    expect(result.id).to.equal('fixture/ExplicitDto');
    expect(result.schema).to.deep.equal({
      $id: 'fixture/ExplicitDto',
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      'x-derived': { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
    });
  });
  it('uses the explicit $id when the schema has one', () => {
    const result = derive('ExplicitWithIdDto');
    expect(result.id).to.equal('fixture/custom-id');
    expect(result.registry.has('fixture/custom-id')).to.be.true;
  });
  it('records a string schema as a $ref without x-derived', () => {
    const result = derive('ExplicitRefDto');
    expect(result.schema).to.deep.equal({ $id: 'fixture/ExplicitRefDto', $ref: 'fixture/by-ref' });
  });
});
