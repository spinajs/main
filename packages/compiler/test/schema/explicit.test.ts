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

describe('explicit @Schema the analyzer cannot fully evaluate', () => {
  const partial = (name: string, body: Record<string, unknown>) => {
    const result = derive(name);
    expect(result.schema).to.deep.equal({ $id: `fixture/${name}`, ...body, 'x-explicit': 'partial' });
    expect(result.schema).not.to.have.property('x-derived');
    expect(result.diagnostics.map((d) => [d.code, d.severity])).to.deep.equal([['SCH006', 'warning']]);
    return result.diagnostics[0].message;
  };

  it('publishes the derived schema, marked partial, when a spread of a call cannot be evaluated', () => {
    const message = partial('ExplicitSpreadDto', {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
      additionalProperties: false,
      description: 'spread of a call',
    });
    expect(message).to.include('ExplicitSpreadDto').and.to.include('helperBody()');
  });
  it('does the same for a non-literal member such as .map(...)', () => {
    const message = partial('ExplicitMappedDto', {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      additionalProperties: false,
      description: 'mapped',
    });
    expect(message).to.include('KEYS.map(');
  });
  it('does the same when the whole argument is not a literal', () => {
    expect(partial('ExplicitCallDto', { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false })).to.include('buildSchema()');
  });
  it('treats a computed key it cannot evaluate as partial and resolves a const one', () => {
    expect(partial('ExplicitUnknownKeyDto', { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false })).to.include('helperBody.name');
    const resolved = derive('ExplicitComputedKeyDto');
    expect(resolved.diagnostics).to.deep.equal([]);
    expect(resolved.schema).to.deep.include({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
  });
});
