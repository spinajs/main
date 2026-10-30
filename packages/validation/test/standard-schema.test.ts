import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { z } from 'zod';
import '@spinajs/log';
import { DataValidator } from '../src/validator.js';
import { Schema, SCHEMA_SYMBOL, isStandardSchema, toValidationErrors, getRegisteredSchema, type StandardSchemaV1 } from '../src/index.js';
import { ValidationFailed } from '../src/exceptions/index.js';

class TestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [] } },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      validation: { allErrors: true, coerceTypes: true, messages: false },
    };
  }
}

function handWritten(validate: StandardSchemaV1['~standard']['validate']): StandardSchemaV1 {
  return { '~standard': { version: 1, vendor: 'hand', validate } };
}

const nameSchema = handWritten((value) => {
  const v = value as { name?: unknown };
  return typeof v?.name === 'string' ? { value: v } : { issues: [{ message: 'Expected string', path: ['name'] }] };
});

describe('Standard Schema input', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.uncache(Configuration);
    DI.uncache(DataValidator);
    await DI.resolve(Configuration);
  });

  after(() => {
    DI.uncache(DataValidator);
    DI.uncache(Configuration);
    DI.unregister(TestConfiguration);
  });

  const validator = () => DI.resolve(DataValidator);

  describe('isStandardSchema', () => {
    it('detects objects and functions that carry ~standard', () => {
      expect(isStandardSchema(nameSchema)).to.be.true;
      const fn = Object.assign(() => 1, { '~standard': { version: 1, vendor: 'x', validate: () => ({ value: 1 }) } });
      expect(isStandardSchema(fn)).to.be.true;
    });
    it('rejects JSON Schema, strings and malformed markers', () => {
      expect(isStandardSchema({ type: 'object' })).to.be.false;
      expect(isStandardSchema('id')).to.be.false;
      expect(isStandardSchema(null)).to.be.false;
      expect(isStandardSchema({ '~standard': {} })).to.be.false;
    });
  });

  describe('toValidationErrors', () => {
    it('maps issues to the Ajv error shape with JSON pointer paths', () => {
      const errors = toValidationErrors([
        { message: 'bad', path: ['a', 0, { key: 'b/c' }] },
        { message: 'root' },
      ]);
      expect(errors).to.deep.equal([
        { keyword: 'standardSchema', instancePath: '/a/0/b~1c', schemaPath: '#', params: {}, message: 'bad' },
        { keyword: 'standardSchema', instancePath: '', schemaPath: '#', params: {}, message: 'root' },
      ]);
    });
  });

  describe('validation', () => {
    it('accepts valid data through ~standard.validate', async () => {
      const v = await validator();
      expect(v.tryValidate(nameSchema, { name: 'x' })).to.deep.equal([true, null]);
      expect(() => v.validate(nameSchema, { name: 'x' })).not.to.throw();
    });

    it('reports issues as Ajv-shaped errors and ValidationFailed', async () => {
      const v = await validator();
      const [ok, errors] = v.tryValidate(nameSchema, { name: 1 });
      expect(ok).to.be.false;
      expect(errors).to.have.lengthOf(1);
      expect(errors![0]).to.include({ keyword: 'standardSchema', instancePath: '/name', message: 'Expected string' });

      try {
        v.validate(nameSchema, { name: 1 });
        expect.fail('should throw');
      } catch (e) {
        expect(e).to.be.instanceOf(ValidationFailed);
        const failed = e as ValidationFailed;
        expect(failed.details).to.deep.equal([{ field: '/name', rule: 'standardSchema', message: 'Expected string', params: {} }]);
        expect(failed.schema).to.equal(nameSchema);
      }
    });

    it('validates a class decorated with @Schema(standard)', async () => {
      @Schema(nameSchema)
      class Dto {
        public name: string;
      }
      const v = await validator();
      expect(Reflect.getMetadata(SCHEMA_SYMBOL, Dto.prototype)).to.equal(nameSchema);
      expect(getRegisteredSchema('Dto')).to.be.undefined;
      expect(v.tryValidate(Object.assign(new Dto(), { name: 'a' }))[0]).to.be.true;
      expect(v.tryValidate(Object.assign(new Dto(), { name: 2 }))[0]).to.be.false;
    });

    it('refuses an asynchronous validator in the synchronous API', async () => {
      const v = await validator();
      const asyncSchema = handWritten(() => Promise.resolve({ value: 1 }));
      expect(() => v.validate(asyncSchema, { a: 1 })).to.throw(InvalidOperation);
    });

    it('does not let a throwing validator leak its message', async () => {
      const v = await validator();
      const throwing = handWritten(() => {
        throw new Error('secret-token');
      });
      const [ok, errors] = v.tryValidate(throwing, { a: 1 });
      expect(ok).to.be.false;
      expect(JSON.stringify(errors)).not.to.include('secret-token');
    });
  });

  describe('callable, async and echoing validators', () => {
    const callable = Object.assign(() => 'callable', {
      '~standard': { version: 1 as const, vendor: 'hand', validate: (value: unknown) => ((value as { n?: unknown })?.n === 1 ? { value } : { issues: [{ message: 'Expected 1', path: ['n'] }] }) },
    });

    it('validates a callable Standard Schema passed directly', async () => {
      const v = await validator();
      expect(v.tryValidate(callable, { n: 1 })).to.deep.equal([true, null]);
      const [ok, errors] = v.tryValidate(callable, { n: 2 });
      expect(ok).to.be.false;
      expect(errors![0]).to.include({ keyword: 'standardSchema', instancePath: '/n' });
    });

    it('awaits an asynchronous validator in validateAsync', async () => {
      const v = await validator();
      const asyncSchema = handWritten(async (value) => ((value as { ok?: boolean }).ok ? { value } : { issues: [{ message: 'nope', path: ['ok'] }] }));
      await v.validateAsync(asyncSchema, { ok: true });
      let failure: unknown;
      try {
        await v.validateAsync(asyncSchema, { ok: false });
      } catch (e) {
        failure = e;
      }
      expect(failure).to.be.instanceOf(ValidationFailed);
      expect((failure as ValidationFailed).details[0]).to.include({ field: '/ok' });
    });

    it('detects thenables that are not native promises', async () => {
      const v = await validator();
      const thenable = handWritten(() => ({ then: (resolve: (r: unknown) => void) => resolve({ issues: [{ message: 'x' }] }) }) as never);
      expect(() => v.validate(thenable, { a: 1 })).to.throw(InvalidOperation, /validateAsync/);
      let failure: unknown;
      try {
        await v.validateAsync(thenable, { a: 1 });
      } catch (e) {
        failure = e;
      }
      expect(failure).to.be.instanceOf(ValidationFailed);
    });

    it('does not echo the input value in issue messages', async () => {
      const v = await validator();
      const echo = handWritten((value) => ({ issues: [{ message: `received ${(value as { password: string }).password}`, path: ['password'] }, { message: 'Too short', path: ['password'] }] }));
      const [, errors] = v.tryValidate(echo, { password: 'hunter2-secret' });
      expect(JSON.stringify(errors)).not.to.include('hunter2-secret');
      expect(errors![0].instancePath).to.equal('/password');
      expect(errors![1].message).to.equal('Too short');
      const asyncEcho = handWritten(async (value) => ({ issues: [{ message: `bad ${(value as { password: string }).password}` }] }));
      let failure: ValidationFailed | undefined;
      try {
        await v.validateAsync(asyncEcho, { password: 'hunter2-secret' });
      } catch (e) {
        failure = e as ValidationFailed;
      }
      expect(JSON.stringify(failure!.details)).not.to.include('hunter2-secret');
    });
  });

  describe('zod', () => {
    const User = z.object({ name: z.string(), age: z.number().int() });

    it('validates with a real zod 4 schema', async () => {
      const v = await validator();
      expect(v.tryValidate(User, { name: 'a', age: 3 })).to.deep.equal([true, null]);
      const [ok, errors] = v.tryValidate(User, { name: 'a', age: 'x' });
      expect(ok).to.be.false;
      expect(errors![0]).to.include({ keyword: 'standardSchema', instancePath: '/age' });
    });
  });
});
