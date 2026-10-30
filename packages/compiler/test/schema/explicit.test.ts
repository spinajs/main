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

describe('Standard Schema as @Schema argument', () => {
  const codes = (name: string) => derive(name).diagnostics.map((d) => [d.code, d.severity]);

  it('reads an exported literal <Name>JsonSchema for zod >= 4 and keeps the derived schema as x-derived', () => {
    const result = derive('StdZodExportedDto');
    expect(result.schema).to.deep.include({
      $id: 'fixture/StdZodExportedDto',
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    });
    expect(result.schema).to.have.property('x-derived');
    expect(result.diagnostics).to.deep.equal([]);
  });
  it('reports SCH004 and publishes the derived schema, marked partial, when zod >= 4 has no exported JSON Schema', () => {
    const result = derive('StdZodMissingDto');
    expect(codes('StdZodMissingDto')).to.deep.equal([['SCH004', 'warning']]);
    expect(result.diagnostics[0].message).to.include('StdZodMissingDtoJsonSchema');
    expect(result.schema).to.deep.equal({
      $id: 'fixture/StdZodMissingDto',
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
      'x-explicit': 'partial',
    });
  });
  it('marks every unreadable Standard Schema partial, whatever the library', () => {
    for (const name of ['StdZod3Dto', 'StdOtherDto', 'StdLocalDto']) {
      expect(derive(name).schema, name).to.deep.include({ 'x-explicit': 'partial' });
    }
  });
  it('reports SCH006 when the exported JSON Schema is not a literal (a call is never executed)', () => {
    const result = derive('StdZodCallDto');
    expect(codes('StdZodCallDto')).to.deep.equal([['SCH006', 'warning']]);
    expect(result.schema).to.deep.include({ 'x-explicit': 'partial' });
  });
  it('reports SCH004 for zod 3 even when a JSON Schema is exported', () => {
    expect(codes('StdZod3Dto')).to.deep.equal([['SCH004', 'warning']]);
    expect(derive('StdZod3Dto').diagnostics[0].message).to.include('zod 3.25.0');
  });
  it('reports SCH004 naming the vendor for other libraries', () => {
    expect(codes('StdOtherDto')).to.deep.equal([['SCH004', 'warning']]);
    expect(derive('StdOtherDto').diagnostics[0].message).to.include('valibot');
  });
  it('treats the zod/v4 subpath of zod 3.25.x as zod 4', () => {
    expect(codes('StdZodV4SubpathDto')).to.deep.equal([]);
    expect(derive('StdZodV4SubpathDto').schema).to.deep.include({ properties: { name: { type: 'string' } } });
  });
  it('labels a locally defined Standard Schema as local, not with the user package name', () => {
    expect(codes('StdLocalDto')).to.deep.equal([['SCH004', 'warning']]);
    const message = derive('StdLocalDto').diagnostics[0].message;
    expect(message).to.include('locally defined').and.to.include('my-lib');
    expect(message).not.to.include('@spinajs/compiler');
  });
});
