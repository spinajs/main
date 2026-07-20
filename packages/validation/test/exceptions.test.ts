import 'mocha';
import { expect } from 'chai';
import { ValidationFailed, IValidationError } from '../src/exceptions/index.js';

// Helper to build ajv-shaped errors without a `message` so we exercise the fallbacks.
function err(partial: Partial<IValidationError>): IValidationError {
  return {
    instancePath: '',
    schemaPath: '',
    keyword: 'type',
    params: {},
    ...partial,
  } as IValidationError;
}

describe('ValidationFailed', () => {
  describe('details building', () => {
    it('builds field / rule / message / params from an ajv error', () => {
      const error = err({
        instancePath: '/user/email',
        keyword: 'format',
        params: { format: 'email' },
        message: 'must match format "email"',
      });

      const ex = new ValidationFailed('validation error', [error], {
        user: { email: 'not-an-email' },
      });

      expect(ex.details).to.have.lengthOf(1);
      const [detail] = ex.details;
      expect(detail.field).to.equal('/user/email');
      expect(detail.rule).to.equal('format');
      expect(detail.message).to.equal('must match format "email"');
      expect(detail.params).to.deep.equal({ format: 'email' });
    });

    it('extracts nested value at instancePath', () => {
      const error = err({
        instancePath: '/user/email',
        keyword: 'format',
        params: { format: 'email' },
      });

      const ex = new ValidationFailed('validation error', [error], {
        user: { email: 'bad-value' },
      });

      expect(ex.details[0].value).to.equal('bad-value');
    });

    it('uses (root) for empty instancePath', () => {
      const error = err({ instancePath: '', keyword: 'type', params: { type: 'object' } });
      const ex = new ValidationFailed('validation error', [error], 'not-an-object');
      expect(ex.details[0].field).to.equal('(root)');
    });
  });

  describe('message fallbacks (ajv message absent)', () => {
    it('required', () => {
      const ex = new ValidationFailed('validation error', [
        err({ keyword: 'required', params: { missingProperty: 'name' } }),
      ]);
      expect(ex.details[0].message).to.equal("Field 'name' is required");
    });

    it('type', () => {
      const ex = new ValidationFailed('validation error', [
        err({ instancePath: '/age', keyword: 'type', params: { type: 'integer' } }),
      ]);
      expect(ex.details[0].message).to.equal('/age must be of type integer');
    });

    it('minLength', () => {
      const ex = new ValidationFailed('validation error', [
        err({ instancePath: '/name', keyword: 'minLength', params: { limit: 3 } }),
      ]);
      expect(ex.details[0].message).to.equal('/name must be at least 3 characters long');
    });

    it('format', () => {
      const ex = new ValidationFailed('validation error', [
        err({ instancePath: '/mail', keyword: 'format', params: { format: 'email' } }),
      ]);
      expect(ex.details[0].message).to.equal('/mail must be a valid email');
    });

    it('enum', () => {
      const ex = new ValidationFailed('validation error', [
        err({ instancePath: '/color', keyword: 'enum', params: { allowedValues: ['red', 'green'] } }),
      ]);
      expect(ex.details[0].message).to.equal('/color must be one of: red, green');
    });
  });

  describe('getSummary', () => {
    it('joins field: message pairs with "; "', () => {
      const ex = new ValidationFailed('validation error', [
        err({ instancePath: '/a', keyword: 'type', params: { type: 'string' } }),
        err({ instancePath: '/b', keyword: 'required', params: { missingProperty: 'b' } }),
      ]);

      expect(ex.getSummary()).to.equal("/a: /a must be of type string; /b: Field 'b' is required");
    });
  });

  describe('getFieldErrors', () => {
    const ex = new ValidationFailed('validation error', [
      err({ instancePath: '/email', keyword: 'format', params: { format: 'email' } }),
      err({ instancePath: '/user/name', keyword: 'minLength', params: { limit: 2 } }),
      err({ instancePath: '/user/age', keyword: 'type', params: { type: 'integer' } }),
    ]);

    it('returns exact-match field errors', () => {
      const errors = ex.getFieldErrors('/email');
      expect(errors).to.have.lengthOf(1);
      expect(errors[0].field).to.equal('/email');
    });

    it('returns prefix-match (nested) field errors', () => {
      const errors = ex.getFieldErrors('/user');
      expect(errors).to.have.lengthOf(2);
      expect(errors.map((e) => e.field)).to.have.members(['/user/name', '/user/age']);
    });
  });

  describe('getFieldRequirements', () => {
    const schema = {
      $id: 'http://spinajs/req.schema.json',
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        user: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2 },
          },
        },
      },
    };

    const ex = new ValidationFailed('validation error', [err({ instancePath: '/email' })], {}, schema);

    it('returns the schema node for an existing top-level field', () => {
      const req = ex.getFieldRequirements('email');
      expect(req).to.deep.equal({ type: 'string', format: 'email' });
    });

    it('returns the schema node for a nested field', () => {
      const req = ex.getFieldRequirements('user/name');
      expect(req).to.deep.equal({ type: 'string', minLength: 2 });
    });

    it('returns null for an unknown field', () => {
      expect(ex.getFieldRequirements('doesNotExist')).to.be.null;
    });
  });

  describe('toString', () => {
    it('contains field, rule, message and the schema $id when a schema is provided', () => {
      const schema = { $id: 'http://spinajs/str.schema.json', type: 'object' };
      const ex = new ValidationFailed(
        'validation error',
        [err({ instancePath: '/email', keyword: 'format', params: { format: 'email' }, message: 'must be email' })],
        { email: 'bad' },
        schema,
      );

      const str = ex.toString();
      expect(str).to.contain('/email');
      expect(str).to.contain('format');
      expect(str).to.contain('must be email');
      expect(str).to.contain('http://spinajs/str.schema.json');
    });
  });
});
