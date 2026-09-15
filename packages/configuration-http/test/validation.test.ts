import { expect } from 'chai';
import 'mocha';
import type { IValidationError } from '@spinajs/validation';
import { formatValidationErrors, valueSchema } from '../src/validation.js';

const err = (instancePath: string, message?: string) => ({ instancePath, message, keyword: 'x', schemaPath: '', params: {} }) as IValidationError;

describe('valueSchema', () => {
  it('returns the plain type schema when no registered schema is referenced', () => {
    expect(valueSchema('string')).to.deep.equal({ type: 'string' });
    expect(valueSchema('number', { min: 1 })).to.deep.equal({ type: 'integer', minimum: 1 });
  });

  it('combines the type schema with a registered schema reference', () => {
    expect(valueSchema('number', { min: 1 }, 'app.maxUsers')).to.deep.equal({
      allOf: [{ type: 'integer', minimum: 1 }, { $ref: 'app.maxUsers' }],
    });
  });

  it('applies meta to array items and the reference to the whole value', () => {
    expect(valueSchema('manyOf', { manyOf: ['a', 'b'] }, 'app.features')).to.deep.equal({
      allOf: [{ type: 'array', uniqueItems: true, items: { type: 'string', enum: ['a', 'b'] } }, { $ref: 'app.features' }],
    });
  });
});

describe('formatValidationErrors', () => {
  it('prefixes the field and strips it from the instance path', () => {
    expect(formatValidationErrors('Value', [err('/Value/perPage', 'must be >= 1')])).to.equal('Value/perPage must be >= 1');
  });

  it('drops duplicate messages produced by both allOf branches', () => {
    expect(formatValidationErrors('Value', [err('/Value', 'must be string'), err('/Value', 'must be string')])).to.equal('Value must be string');
  });

  it('falls back to a generic message', () => {
    expect(formatValidationErrors('Default', [err('/Default')])).to.equal('Default is invalid');
    expect(formatValidationErrors('Default', [])).to.equal('invalid value for Default');
    expect(formatValidationErrors('Default', null)).to.equal('invalid value for Default');
  });
});
